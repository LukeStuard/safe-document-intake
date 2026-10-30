HttpRequest r = new HttpRequest();
r.setEndpoint('callout:Intake_Worker/hooks/salesforce');
r.setMethod('POST');
r.setHeader('Content-Type', 'text/plain');
r.setHeader('X-Intake-Signature',
    '{!BASE64ENCODE(HMAC(\'SHA-256\', BLOB(\'probe\'), BLOB($Credential.Intake_Signing.SigningKey)))}');
r.setBody('probe');
HttpResponse res = new Http().send(r);
System.debug('probe status=' + res.getStatusCode());