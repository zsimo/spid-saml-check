const samlProtocol = require("./saml-protocol/protocol-bindings");
const errors = require("./saml-protocol/errors");
const namespaces = require("./saml-protocol/namespaces");
const saml = require("./saml-protocol");
const xmldom = require("xmldom");
const xpath = require("xpath");
const DOMParser = xmldom.DOMParser;
const zlib = require("zlib");
const path = require("path");
const fs = require("fs");

const select = xpath.useNamespaces({
    ...namespaces, 
    "spid": "https://spid.gov.it/saml-extensions"
});



class TestSuite {

    constructor(config_idp, config_test) {
        this.config = {
            idp: config_idp,
            test: config_test
        } 
    }

    getTestTemplate(testsuiteId, testcaseId, requestedAttributes, defaultParams, userParams) {
        
        let testsuite = this.config.test[testsuiteId];
        let testcase = testsuite.cases[testcaseId];
        let template = fs.readFileSync(testcase.path, "utf8");
        let attributesNameFormat = (testcase.attributesNameFormat!=null)? testcase.attributesNameFormat:true;
        let params = [];
        
        let compiled = template;

        // Compile response template from config data
        compiled.match(/{{\s*[\w\.]+\s*}}/g).map((e) => {
            let eKey = e.replace("{{", "").replace("}}", "");

            let eVal = null;

            let defaultParam = defaultParams.filter((p)=> { return (p.key==eKey) })[0];
            let userParam = userParams.filter((p)=> { return (p.key==eKey) })[0];

            eVal = (defaultParam!=null)? defaultParam.val : null;
            eVal = (testsuite.response[eKey]!=null && testsuite.response[eKey]!="")? testsuite.response[eKey] : eVal;
            eVal = (testcase.response[eKey]!=null && testcase.response[eKey]!="")? testcase.response[eKey] : eVal;
            eVal = (userParam!=null)? userParam.val : eVal;

            if (eVal == null) eVal = "";
            
            if(eKey=="Attributes") {
                let attributesCompiled = "";
                for(let attributeName in eVal) {
                    
                    // override value from fontend
                    userParam = userParams.filter((p)=> { return (p.key==attributeName) })[0];
                    let userVal = (userParam!=null)? userParam.val : eVal[attributeName];
                    let attributeVal = userVal;

                    // requestedAttributs === true for all, or array for selected
                    if(requestedAttributes===true ||
                        requestedAttributes.indexOf(attributeName)>-1 ||
                        userParam!=null) {

                        if(attributeVal!=null) {
                            if(attributeName=="dateOfBirth" || attributeName=="expirationDate") {
                                attributesCompiled += " \
                                    <saml:Attribute Name=\"" + attributeName + "\" ";
                                        if(attributesNameFormat) attributesCompiled += " NameFormat=\"urn:oasis:names:tc:SAML:2.0:attrname-format:basic\"";
                                        attributesCompiled += "> \
                                        <saml:AttributeValue xmlns:xs=\"http://www.w3.org/2001/XMLSchema\" \
                                            xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\" xsi:type=\"xs:date\">"
                                                + attributeVal +
                                        "</saml:AttributeValue> \
                                    </saml:Attribute> \
                                ";
                            } else {
                                attributesCompiled += " \
                                    <saml:Attribute Name=\"" + attributeName + "\" ";
                                        if(attributesNameFormat) attributesCompiled += " NameFormat=\"urn:oasis:names:tc:SAML:2.0:attrname-format:basic\"";
                                        attributesCompiled += "> \
                                        <saml:AttributeValue xmlns:xs=\"http://www.w3.org/2001/XMLSchema\" \
                                            xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\" xsi:type=\"xs:string\">"
                                                + attributeVal +
                                        "</saml:AttributeValue> \
                                    </saml:Attribute> \
                                ";
                            }
                        }

                    } else {
                        attributeVal = null;
                    }

                    // if params not yet contains param
                    if(params.filter((p)=> {
                        return (p.key == attributeName);
                    }).length == 0) {
                        params.push({ "key": attributeName, "val": attributeVal, "attribute": true });
                    }
                }         
                
                compiled = compiled.replace("{{Attributes}}", attributesCompiled);  

            } else {
                compiled = compiled.replaceAll(e, eVal);

                // if params not yet contains param
                if(params.filter((p)=> {
                    return (p.key == eKey);
                }).length == 0) {
                    params.push({ "key": eKey, "val": eVal, "attribute": false });
                }
            }
        });
        
        return {
            testsuite: testsuite.description,
            name: testcase.name,
            description: testcase.description,
            template: template,
            params: params,
            compiled: compiled,
            sign_response: testcase.sign_response,
            sign_assertion: testcase.sign_assertion,
            sign_credentials: testcase.sign_credentials
        };
    };

    getDestination(testsuiteId) {
        let testsuite = this.config.test[testsuiteId];
        let destination = testsuite.response.AssertionConsumerURL;
        return destination;
    };
}




class PayloadDecoder {

    static decode(payload) {
        let xml = samlProtocol.decodeXMLPayload(payload);
        return xml;
    }
}



class MetadataParser {

    constructor(xml) {
        this.metadata = {
            xml: xml
        }
    }

    getServiceProviderEntityId() {
        let doc = new DOMParser().parseFromString(this.metadata.xml);
        let serviceProviderEntityId = select("//md:EntityDescriptor", doc)[0].getAttribute("entityID");
        return serviceProviderEntityId;
    }

    getAssertionConsumerServiceURL(index) {
        let assertionConsumerServiceURL = null;
        let doc = new DOMParser().parseFromString(this.metadata.xml);
        let acs = select("//md:EntityDescriptor/md:SPSSODescriptor/md:AssertionConsumerService", doc);
        for(let i in acs) {
            let acsIndex = acs[i].getAttribute("index");
            let acsIsDefault = acs[i].getAttribute("isDefault");
            let acsLocation = acs[i].getAttribute("Location");
            if(index==acsIndex) {
                assertionConsumerServiceURL = acsLocation;
                break;
            }
        }
        return assertionConsumerServiceURL;
    }

    getSingleLogoutServiceURL() {
        let singleLogoutServiceURL = [];
        let doc = new DOMParser().parseFromString(this.metadata.xml);
        let slo = select("//md:EntityDescriptor/md:SPSSODescriptor/md:SingleLogoutService", doc);
        for(let i in slo) {
            let sloLocation = slo[i].getAttribute("Location");
            singleLogoutServiceURL.push(sloLocation);
        }
        return singleLogoutServiceURL;
    }

    getAttributeConsumingService(index) {
        let attributeConsumingService = {ServiceName: "", RequestedAttributes:[]};
        let doc = new DOMParser().parseFromString(this.metadata.xml);
        let acs = select("//md:EntityDescriptor/md:SPSSODescriptor/md:AttributeConsumingService", doc);
        for(let i in acs) {
            let acsIndex = acs[i].getAttribute("index");
            if(index==acsIndex) {
                let serviceName = select("string(//md:ServiceName)", acs[i]);
                let attributes = select("md:RequestedAttribute", acs[i]);
                attributeConsumingService.ServiceName = serviceName;
                for(let j in attributes) {
                    let friendlyName = attributes[j].getAttribute("FriendlyName");
                    let name = attributes[j].getAttribute("Name");
                    attributeConsumingService.RequestedAttributes.push({FriendlyName: friendlyName, Name: name});
                }
                break;
            }
        }
        return attributeConsumingService;
    }

    getOrganization() {
        let organization = {
            name: "",
            displayName: "",
            url: ""   
        };

        let doc = new DOMParser().parseFromString(this.metadata.xml);

        let organization_name = select("//md:EntityDescriptor/md:Organization/md:OrganizationName", doc);
        if(organization_name && organization_name.length>0) {
            organization.name = select("string(//md:OrganizationName)", organization_name[0]);
            if(organization_name.length > 1) {
                for(let n in organization_name) {
                    let name = organization_name[n];
                    if(name.getAttribute("lang")=="it") {
                        organization.name = select("string(//)", name);
                    }
                }
            }
        }

        let organization_display_name = select("//md:EntityDescriptor/md:Organization/md:OrganizationDisplayName", doc);
        if(organization_display_name && organization_display_name.length>0) {
            organization.displayName = select("string(//md:OrganizationDisplayName)", organization_display_name[0]);
            if(organization_display_name.length > 1) {
                for(let n in organization_display_name) {
                    let display_name = organization_display_name[n];
                    if(display_name.getAttribute("lang")=="it") {
                        organization.displayName = select("string(//)", display_name);
                    }
                }
            }
        }

        let organization_url = select("//md:EntityDescriptor/md:Organization/md:OrganizationURL", doc);
        if(organization_url && organization_url.length>0) {
            organization.url = select("string(//md:OrganizationURL)", organization_url[0]);
            if(organization_url.length > 1) {
                for(let n in organization_url) {
                    let url = organization_url[n];
                    if(url.getAttribute("lang")=="it") {
                        organization.url = select("string(//)", url);
                    }
                }
            }
        }

        return organization;
    }

    getSPIDContactPerson() {
        let contact_person = [];

        let doc = new DOMParser().parseFromString(this.metadata.xml);

        let contact_person_doc = select("//md:EntityDescriptor/md:ContactPerson", doc);
        for(let n in contact_person_doc) {
            let cpe = contact_person_doc[n];
            let cpe_contact_type = cpe.getAttribute("contactType");
            let cpe_entity_type = cpe.getAttribute("spid:entityType");

            if(cpe_contact_type=="other") {
                if(cpe_entity_type=="spid:aggregator" || cpe_entity_type=="spid:aggregated") {

                    contact_person.push({
                        type: cpe_entity_type,
                        Company: select("string(md:Company)", cpe),
                        VATNumber: select("string(md:Extensions/spid:VATNumber)", cpe),
                        IPACode: select("string(md:Extensions/spid:IPACode)", cpe),
                        FiscalCode: select("string(md:Extensions/spid:FiscalCode)", cpe)
                    });
                }
            }
        }

        return contact_person;
    }

    isMetadataForAggregated() {
        let contactPerson = this.getSPIDContactPerson();

        let assertLength = (contactPerson.length==2);
        let assertAggregator = false;
        let assertAggregated = false;

        for(let n in contactPerson) {
            assertAggregator = assertAggregator || (contactPerson[n].type=="spid:aggregator");
            assertAggregated = assertAggregated || (contactPerson[n].type=="spid:aggregated");
        }
        
        return assertLength && assertAggregator && assertAggregated;
    }

    getSPIDAggregatorContactPerson() {
        let aggregator = null;
        if(this.isMetadataForAggregated()) {
            let contactPerson = this.getSPIDContactPerson();
            for(let n in contactPerson) {
                if(contactPerson[n].type=="spid:aggregator")
                    aggregator = contactPerson[n];
            }
        }

        return aggregator;
    }

    getSPIDAggregatedContactPerson() {
        let aggregated = null;
        if(this.isMetadataForAggregated()) {
            let contactPerson = this.getSPIDContactPerson();
            for(let n in contactPerson) {
                if(contactPerson[n].type=="spid:aggregated")
                    aggregated = contactPerson[n];
            }
        }
        
        return aggregated;
    }
}


class RequestParser {

    constructor(xml) {
        let isAuthnRequest = false;
        let isLogout = false;

        let doc = new DOMParser().parseFromString(xml);
        if(select("//samlp:AuthnRequest", doc).length>0) isAuthnRequest = true;
        if(select("//samlp:LogoutRequest", doc).length>0) isLogout = true

        let type = 0;   // 0: unknown, 1: AuthnRequest, 2: Logout

        if(isAuthnRequest) type = 1;
        else if(isLogout) type = 2;

        this.request = {
            xml: xml,
            type: type
        }
    }

    isAuthnRequest() { return (this.request.type==1)? true : false; }
    isLogoutRequest() { return (this.request.type==2)? true : false; }

    ID() {
        let samlp = (this.request.type==1)? "AuthnRequest" : "LogoutRequest";
        let doc = new DOMParser().parseFromString(this.request.xml);
        let requestID = select("//samlp:" + samlp, doc)[0];
        if(requestID!=null) requestID = requestID.getAttribute("ID") 
        else requestID = undefined;
        return requestID;
    }

    IssueInstant() {
        let samlp = (this.request.type==1)? "AuthnRequest" : "LogoutRequest";
        let doc = new DOMParser().parseFromString(this.request.xml);
        let requestIssueInstant = select("//samlp:" + samlp, doc)[0];
        if(requestIssueInstant!=null) requestIssueInstant = requestIssueInstant.getAttribute("IssueInstant") 
        else requestIssueInstant = undefined;
        return requestIssueInstant;
    }

    Issuer() {
        let samlp = (this.request.type==1)? "AuthnRequest" : "LogoutRequest";
        let doc = new DOMParser().parseFromString(this.request.xml);
        let issuer = select("string(//samlp:" + samlp + "/saml:Issuer)", doc);
        return issuer.trim();
    }

    AuthnContextClassRef() { // only for type 1
        let doc = new DOMParser().parseFromString(this.request.xml);
        let requestAuthnContextClassRef = select("string(//samlp:AuthnRequest/samlp:RequestedAuthnContext/saml:AuthnContextClassRef)", doc);
        return requestAuthnContextClassRef;
    }

    AssertionConsumerServiceURL() { // only for type 1
        let doc = new DOMParser().parseFromString(this.request.xml);
        let requestAssertionConsumerServiceURL = select("//samlp:AuthnRequest", doc)[0];
        if(requestAssertionConsumerServiceURL!=null) requestAssertionConsumerServiceURL = requestAssertionConsumerServiceURL.getAttribute("AssertionConsumerServiceURL") 
        else requestAssertionConsumerServiceURL = undefined;
        return requestAssertionConsumerServiceURL;
    }

    AssertionConsumerServiceIndex() { // only for type 1
        let doc = new DOMParser().parseFromString(this.request.xml);
        let requestAssertionConsumerServiceIndex = select("//samlp:AuthnRequest", doc)[0];
        if(requestAssertionConsumerServiceIndex!=null) requestAssertionConsumerServiceIndex = requestAssertionConsumerServiceIndex.getAttribute("AssertionConsumerServiceIndex") 
        else requestAssertionConsumerServiceIndex = undefined;
        return requestAssertionConsumerServiceIndex;
    }

    AttributeConsumingServiceIndex() { // only for type 1
        let doc = new DOMParser().parseFromString(this.request.xml);
        let requestAttributeConsumingServiceIndex = select("//samlp:AuthnRequest", doc)[0];
        if(requestAttributeConsumingServiceIndex!=null) requestAttributeConsumingServiceIndex = requestAttributeConsumingServiceIndex.getAttribute("AttributeConsumingServiceIndex") 
        else requestAttributeConsumingServiceIndex = undefined;
        return requestAttributeConsumingServiceIndex;
    }

    Purpose() { // only for type 1
        let doc = new DOMParser().parseFromString(this.request.xml);
        let purpose = select("string(//samlp:AuthnRequest/samlp:Extensions/spid:Purpose)", doc);
        return purpose;
    }

    MinAge() { // only for type 1
        let doc = new DOMParser().parseFromString(this.request.xml);
        let minAge = select("string(//samlp:AuthnRequest/samlp:Extensions/spid:AgeLimit/spid:MinAge)", doc);
        return minAge;
    }

    MaxAge() { // only for type 1
        let doc = new DOMParser().parseFromString(this.request.xml);
        let maxAge = select("string(//samlp:AuthnRequest/samlp:Extensions/spid:AgeLimit/spid:MaxAge)", doc);
        return maxAge;
    }
}

class IdPModel { 
    /*
    getServiceProvider(entityID) {
	    return new Promise(function (resolve, reject) {
		    try {
			    resolve(getMetadataSP(entityID));
		    } catch(e) {
			    reject("ERROR");
		    }
	    }
    );
    */
}


class IdP {
    constructor(idpConfig) {
        this.idp = new saml.IdentityProvider(idpConfig, new IdPModel());
    }
    
    getMetadata() {
        return this.idp.produceIDPMetadata(true);
    }

    getLogoutResponseURL(url, SAMLResponse, sigAlg, signature, relayState) {
        let qs = "";

        if (signature !== null) {
            qs += this.getLogoutResponsePayload(SAMLResponse, relayState, sigAlg);
            qs += "&Signature=" + encodeURIComponent(signature);
        } else {
            qs += this.getLogoutResponsePayload(SAMLResponse, relayState, null);
        }

        return url + "?" + qs;
    }

    getLogoutResponsePayload(SAMLResponse, relayState, sigAlg) {
        let qs = "SAMLResponse=" + encodeURIComponent(zlib.deflateRawSync(SAMLResponse).toString("base64"));
        qs += "&RelayState=" + encodeURIComponent(relayState);
        qs += (sigAlg !== null) ? "&SigAlg=" + encodeURIComponent(sigAlg) : "";

        return qs;
    }
}


module.exports.TestSuite = TestSuite;
module.exports.MetadataParser = MetadataParser;
module.exports.RequestParser = RequestParser;
module.exports.PayloadDecoder = PayloadDecoder;
module.exports.IdP = IdP;
