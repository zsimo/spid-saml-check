const p = require("./package.json");
const express = require("express");
const exphbs  = require('express-handlebars');
const helmet = require("helmet");
const session = require("express-session");
const bodyParser = require("body-parser");
const path = require('path');
const fs = require("fs-extra");
const moment = require("moment");

const config_test = require("../config/test.json");
const config_idp = require("../config/idp.json");
const config_dir = require("../config/dir.json");
const config_api = require("../config/api.json");

const Utility = require("./lib/utils");
const TestSuite = require("./lib/saml-utils").TestSuite;
const PayloadDecoder = require("./lib/saml-utils").PayloadDecoder;
const MetadataParser = require("./lib/saml-utils").MetadataParser;
const RequestParser = require("./lib/saml-utils").RequestParser;
const IdP = require("./lib/saml-utils").IdP;
const Signer = require("./lib/signer").Signer;
const SIGN_MODE = require("./lib/signer").SIGN_MODE;

const Database = require("./lib/database");
const Authenticator = require("./lib/authenticator");

const useHttps = config_idp.useHttps;
let https;
let httpsPrivateKey;
let httpsCertificate;
let httpsCredentials;
if (useHttps) {
    https = require('https');
    httpsPrivateKey  = fs.readFileSync(config_idp.httpsPrivateKey, 'utf8');
    httpsCertificate = fs.readFileSync(config_idp.httpsCertificate, 'utf8');
    httpsCredentials = {key: httpsPrivateKey, cert: httpsCertificate};
}

var app = express();
app.use(helmet());

app.use(bodyParser.json({limit: '3mb', extended: true}));
app.use(bodyParser.urlencoded({limit: '3mb', extended: true}));
app.use(express.static(path.resolve(__dirname, "..", "client/build/assets")));
app.use("/assets", express.static(path.resolve(__dirname, "..", "client/build/assets")));

app.set('trust proxy', 1);
app.use(session({
    secret: "SAML IDP",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 60*60000 }  //30*60000: 30min
}));


// create database
var database = new Database().connect().setup();

// create authenticator
var authenticator = new Authenticator("validator");

// use template handlebars
app.set('views', './client/view');
app.engine('handlebars', exphbs({defaultLayout: false}));
app.set('view engine', 'handlebars');


// Private Funcs
var checkAuth = function(req) {
    // 'API' if checkBasicAuth = true
    // true if checkSessionAuth = true
    // else false
    return checkBasicAuth(req) || checkSessionAuth(req);
}

var checkSessionAuth = function(req) {
    let authorised = false;
    let apikey = req.query.apikey;
    if(apikey!=null && apikey == req.session.apikey) {
        authorised = true;
    } else {
        Utility.log("Authorisation", "ERROR check authorisation : " + apikey);
        authorised = false;
    }
    return authorised;
}

var checkBasicAuth = function(req) {
    let authorised = false;
    if(req.headers.authorization
        && req.headers.authorization.substr(0,5)=="Basic") {
        let authorization = req.headers.authorization.substr(6);
        let authorization_buffer = new Buffer(authorization, 'base64');
        let authorization_plain = authorization_buffer.toString('ascii');
        let user = authorization_plain.split(":")[0];
        let pass = authorization_plain.split(":")[1];
        if(config_api[user]==pass) authorised = 'API';
        Utility.log("Authorisation API", authorization_plain);
    }
    return authorised;
}

var getEntityDir = function(issuer) {
    let ENTITY_DIR = config_dir.DATA + "/" + issuer.normalize();
    if(!fs.existsSync(ENTITY_DIR)) fs.mkdirSync(ENTITY_DIR);
    return ENTITY_DIR;
}

var sendLogoutResponse = function(req, res) {

    if(req.session!=null && req.session.request!=null && req.session.request.issuer!=null) {

        // default params if no authnrequest
        let authnRequestID = (req.session.request!=null)? req.session.request.id : Utility.getUUID();
        let issueInstant = (req.session.request!=null)? req.session.request.issueInstant : Utility.getInstant();
        let assertionConsumerURL = (req.session.request!=null)? req.session.request.assertionConsumerServiceURL : null;
        let assertionConsumerIndex = (req.session.request!=null)? req.session.request.assertionConsumerServiceIndex : null;

        // if no AssertionConsumerURL from request try to get it from metadata
        if((assertionConsumerURL==null || assertionConsumerURL=="") &&
            (assertionConsumerIndex!=null && assertionConsumerIndex!="")) {

            if(req.session.metadata!=null) {
                let metadataParser = new MetadataParser(req.session.metadata.xml);
                assertionConsumerURL = metadataParser.getAssertionConsumerServiceURL(assertionConsumerIndex);
            }
        }

        let requestedAttributes = [];
        let serviceProviderEntityId = "";
        let singleLogoutServiceURL = [];

        let isMetadataLoaded = (req.session.metadata!=null && req.session.metadata.xml!=null);

        if(req.session.request!=null && isMetadataLoaded) {
            let requestParser = new RequestParser(req.session.request.xml);
            let metadataParser = new MetadataParser(req.session.metadata.xml);
            serviceProviderEntityId = metadataParser.getServiceProviderEntityId();
            singleLogoutServiceURL = metadataParser.getSingleLogoutServiceURL();

        } else {
            requestedAttributes = true;
        }

        // defaults
        let defaults = []; // clone array
        defaults = Utility.defaultParam(defaults, "ResponseID", Utility.getUUID());
        defaults = Utility.defaultParam(defaults, "IssueInstant", Utility.getInstant());
        defaults = Utility.defaultParam(defaults, "Destination", singleLogoutServiceURL[0]);
        defaults = Utility.defaultParam(defaults, "AuthnRequestID", authnRequestID);
        defaults = Utility.defaultParam(defaults, "NameQualifier", "https://validator.spid.gov.it");
        defaults = Utility.defaultParam(defaults, "Issuer", config_idp.entityID);

        let testSuite = new TestSuite(config_idp, config_test);
        let logoutResponse = testSuite.getTestTemplate("test-logout", "1", requestedAttributes, defaults, []);
        let signature = null;

        let idp = new IdP(config_idp);
        let sign_credentials = (logoutResponse.sign_credentials!=null)?
            logoutResponse.sign_credentials : config_idp.credentials[0];
        let SAMLResponse = logoutResponse.compiled;
        let sigAlg = sign_credentials.signatureAlgorithm;
        let relayState = req.session.request.relayState;

        // defaults
        sign_response = logoutResponse.sign_response;

        if(sign_response) {
            let mode = SIGN_MODE.GET_SIGNATURE;
            let logoutResponsePayload = idp.getLogoutResponsePayload(SAMLResponse, relayState, sigAlg);
            signer = new Signer(sign_credentials);
            signature = signer.sign(logoutResponsePayload, mode);
        }

        req.session.destroy();

        let url = singleLogoutServiceURL[0];
        let logoutURL = idp.getLogoutResponseURL(url, SAMLResponse, sigAlg, signature, relayState);
        res.redirect(logoutURL);

    } else {
        res.status(400).send("Session not found");
    }
}



app.use((req, res, next)=> {
    console.log(".\n.\n.");
    Utility.log(moment().format("YYYY-MM-DD HH:mm:ss") + " - " + req.method + " [" + req.ips.join(' - ') + "] " + req.path);
    next();
});



/* IDP */
require('./app/idp')		    (app, checkAuth, getEntityDir, sendLogoutResponse);
require('./app/idp_demo')       (app, checkAuth, getEntityDir, sendLogoutResponse, database);
require('./app/auth')		    (app, checkAuth, authenticator);

/* API */
require('./api/info')		    (app, checkAuth);
require('./api/store')		    (app, checkAuth, getEntityDir, database);
require('./api/metadata-sp')	(app, checkAuth, getEntityDir, database);
require('./api/request')    	(app, checkAuth, getEntityDir, database);
require('./api/response')    	(app, checkAuth);




// start
if (useHttps) app = https.createServer(httpsCredentials, app);
app.listen(8080, () => {
    // eslint-disable-next-line no-console
    console.log("\n" + p.name + "\nversion: " + p.version + "\n\nlistening on port 8080");
});
