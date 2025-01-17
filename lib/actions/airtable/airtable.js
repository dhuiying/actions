"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AirtableAction = void 0;
const Hub = require("../../hub");
const crypto = require("crypto");
const gaxios = require("gaxios");
const qs = require("qs");
const winston = require("winston");
const airtable = require("airtable");
class AirtableAction extends Hub.OAuthAction {
    constructor() {
        super(...arguments);
        this.name = "airtable";
        this.label = "Airtable";
        this.iconName = "airtable/airtable.png";
        this.description = "Add records to an Airtable table.";
        this.params = [];
        this.supportedActionTypes = [Hub.ActionType.Query];
        this.supportedFormats = [Hub.ActionFormat.JsonDetail];
        this.supportedFormattings = [Hub.ActionFormatting.Unformatted];
        this.supportedVisualizationFormattings = [Hub.ActionVisualizationFormatting.Noapply];
        this.SCOPE = "data.records:write schema.bases:read schema.bases:write";
    }
    execute(request) {
        return __awaiter(this, void 0, void 0, function* () {
            if (!(request.attachment && request.attachment.dataJSON)) {
                throw "No attached json.";
            }
            if (!(request.formParams.base && request.formParams.table)) {
                throw "Missing Airtable base or table.";
            }
            const qr = request.attachment.dataJSON;
            if (!qr.fields || !qr.data) {
                throw "Request payload is an invalid format.";
            }
            const fields = [].concat(...Object.keys(qr.fields).map((k) => qr.fields[k]));
            const fieldMap = {};
            for (const field of fields) {
                fieldMap[field.name] = field.label_short || field.label || field.name;
            }
            const records = qr.data.map((row) => {
                const record = {};
                for (const field of fields) {
                    record[fieldMap[field.name]] = row[field.name].value;
                }
                return record;
            });
            let response;
            try {
                const airtableClient = yield this.airtableClientFromRequest(request);
                const base = airtableClient.base(request.formParams.base);
                const table = base(request.formParams.table);
                yield Promise.all(records.map((record) => __awaiter(this, void 0, void 0, function* () {
                    return new Promise((resolve, reject) => {
                        table.create(record, (err, rec) => {
                            if (err) {
                                reject(err);
                            }
                            else {
                                resolve(rec);
                            }
                        });
                    });
                })));
            }
            catch (e) {
                response = { success: false, message: e.message };
            }
            return new Hub.ActionResponse(response);
        });
    }
    checkBaseList(request) {
        return __awaiter(this, void 0, void 0, function* () {
            if (request.params.state_json) {
                const stateJson = JSON.parse(request.params.state_json);
                const response = yield this.refreshTokens(stateJson.tokens.refresh_token);
                return gaxios.request({
                    method: "GET",
                    url: "https://api.airtable.com/v0/meta/bases",
                    headers: {
                        Authorization: `Bearer ${response.data.access_token}`,
                    },
                }).catch((err) => {
                    winston.error(JSON.stringify(err));
                    throw "Error listing bases, oauth probably bad.";
                });
            }
            else {
                return null;
            }
        });
    }
    form(request) {
        return __awaiter(this, void 0, void 0, function* () {
            const form = new Hub.ActionForm();
            try {
                const response = yield this.checkBaseList(request);
                if (response === null) {
                    // @ts-ignore
                    throw "Error with checking baselist";
                }
                winston.info(JSON.stringify(response));
                form.fields = [{
                        label: "Airtable Base",
                        name: "base",
                        required: true,
                        type: "string",
                    }, {
                        label: "Airtable Table",
                        name: "table",
                        required: true,
                        type: "string",
                    }];
            }
            catch (e) {
                // prevents others from impersonating you
                const codeVerifier = crypto.randomBytes(96).toString("base64url"); // 128 characters
                const actionCrypto = new Hub.ActionCrypto();
                const jsonString = JSON.stringify({ stateurl: request.params.state_url, verifier: codeVerifier });
                const ciphertextBlob = yield actionCrypto.encrypt(jsonString).catch((err) => {
                    winston.error("Encryption not correctly configured");
                    throw err;
                });
                form.fields = [{
                        label: "Login",
                        name: "oauth",
                        type: "oauth_link",
                        oauth_url: `${process.env.ACTION_HUB_BASE_URL}/actions/${this.name}/oauth?state=${ciphertextBlob}`,
                    }];
            }
            return form;
        });
    }
    oauthCheck(_request) {
        return __awaiter(this, void 0, void 0, function* () {
            return false;
        });
    }
    oauthFetchInfo(urlParams, redirectUri) {
        return __awaiter(this, void 0, void 0, function* () {
            const actionCrypto = new Hub.ActionCrypto();
            const plaintext = yield actionCrypto.decrypt(urlParams.state).catch((err) => {
                winston.error("Encryption not correctly configured" + err);
                throw err;
            });
            const payload = JSON.parse(plaintext);
            const dataString = qs.stringify({
                clientId: process.env.AIRTABLE_CLIENT_ID,
                grant_type: "authorization_code",
                code_verifier: payload.verifier,
                redirect_uri: redirectUri,
                code: urlParams.code,
            });
            const encodedCreds = Buffer.from(`${process.env.AIRTABLE_CLIENT_ID}:${process.env.AIRTABLE_CLIENT_SECRET}`)
                .toString("base64");
            const response = yield gaxios.request({
                method: "POST",
                url: "https://www.airtable.com/oauth2/v1/token",
                headers: {
                    "Authorization": `Basic ${encodedCreds}`,
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                data: dataString,
            });
            JSON.stringify(response.data);
            // Pass back context to Looker
            if (response.status === 200) {
                const data = response.data;
                yield gaxios.request({
                    url: payload.stateurl,
                    method: "POST",
                    body: JSON.stringify({ tokens: {
                            refresh_token: data.refresh_token,
                            access_token: data.access_token,
                        }, redirect: redirectUri }),
                }).catch((_err) => { winston.error(_err.toString()); });
            }
            else {
                winston.warn("Oauth for Airtable unsuccessful");
                throw "OAuth did not work";
            }
        });
    }
    oauthUrl(redirectUri, encryptedState) {
        return __awaiter(this, void 0, void 0, function* () {
            const clientId = process.env.AIRTABLE_CLIENT_ID ? process.env.AIRTABLE_CLIENT_ID : "must exist";
            const actionCrypto = new Hub.ActionCrypto();
            const plaintext = yield actionCrypto.decrypt(encryptedState).catch((err) => {
                winston.error("Encryption not correctly configured" + err);
                throw err;
            });
            const payload = JSON.parse(plaintext);
            // prevents others from impersonating you
            const codeVerifier = payload.verifier; // 128 characters
            const codeChallengeMethod = "S256";
            const codeChallenge = crypto
                .createHash("sha256")
                .update(codeVerifier) // hash the code verifier with the sha256 algorithm
                .digest("base64") // base64 encode, needs to be transformed to base64url
                .replace(/=/g, "") // remove =
                .replace(/\+/g, "-") // replace + with -
                .replace(/\//g, "_"); // replace / with _ now base64url encoded
            // build the authorization URL
            const authorizationUrl = new URL(`https://www.airtable.com/oauth2/v1/authorize`);
            authorizationUrl.searchParams.set("code_challenge", codeChallenge);
            authorizationUrl.searchParams.set("code_challenge_method", codeChallengeMethod);
            authorizationUrl.searchParams.set("state", encryptedState);
            authorizationUrl.searchParams.set("client_id", clientId);
            authorizationUrl.searchParams.set("redirect_uri", redirectUri);
            authorizationUrl.searchParams.set("response_type", "code");
            // your OAuth integration register with these scopes in the management page
            authorizationUrl.searchParams.set("scope", this.SCOPE);
            return authorizationUrl.toString();
        });
    }
    airtableClientFromRequest(request) {
        return __awaiter(this, void 0, void 0, function* () {
            if (request.params.state_json) {
                const stateJson = JSON.parse(request.params.state_json);
                const response = yield this.refreshTokens(stateJson.tokens.refresh_token);
                return new airtable({ apiKey: response.data.access_token });
            }
            else {
                return null;
            }
        });
    }
    refreshTokens(refreshToken) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const dataString = qs.stringify({
                    client_id: process.env.AIRTABLE_CLIENT_ID,
                    grant_type: "refresh_token",
                    refresh_token: refreshToken,
                });
                const encodedCreds = Buffer.from(`${process.env.AIRTABLE_CLIENT_ID}:${process.env.AIRTABLE_CLIENT_SECRET}`)
                    .toString("base64");
                return yield gaxios.request({
                    method: "POST",
                    url: "https://www.airtable.com/oauth2/v1/token",
                    headers: {
                        "Authorization": `Basic ${encodedCreds}`,
                        "Content-Type": "application/x-www-form-urlencoded",
                    },
                    data: dataString,
                });
            }
            catch (e) {
                winston.warn("Error with Airtable Access Token Refresh");
                return { data: {} };
            }
        });
    }
}
exports.AirtableAction = AirtableAction;
if (process.env.AIRTABLE_CLIENT_ID && process.env.AIRTABLE_CLIENT_SECRET) {
    Hub.addAction(new AirtableAction());
}
