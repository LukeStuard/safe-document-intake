@IsTest
private class IntakeTriggerSenderTest {
  // Records every callout instead of sending it. Apex tests can't reach the network,
  // and Named Credential formulas aren't evaluated in tests, so these tests prove what
  // gets sent and when. The signature itself is proven end to end in the org.
  private class CaptureMock implements HttpCalloutMock {
    final Integer status;
    final List<HttpRequest> requests = new List<HttpRequest>();

    CaptureMock(Integer status) {
      this.status = status;
    }

    public HttpResponse respond(HttpRequest request) {
      requests.add(request);
      HttpResponse response = new HttpResponse();
      response.setStatusCode(status);
      return response;
    }
  }

  @TestSetup
  static void setup() {
    Contact applicant = new Contact(
      FirstName = 'Jordan',
      LastName = 'Whitcombe'
    );
    insert applicant;
    Application__c app = new Application__c(
      Applicant__c = applicant.Id,
      Program__c = 'MBA',
      Term__c = 'Fall 2027',
      Status__c = 'Submitted',
      Submitted_Date__c = Date.today()
    );
    insert app;
    insert new Checklist_Item__c(
      Application__c = app.Id,
      Document_Type__c = 'Transcript',
      Status__c = 'Received'
    );
  }

  private static Checklist_Item__c item() {
    return [SELECT Id FROM Checklist_Item__c LIMIT 1];
  }

  private static ContentVersion upload(Id parentId) {
    ContentVersion version = new ContentVersion(
      Title = 'doc-0001',
      PathOnClient = 'doc-0001.pdf',
      VersionData = Blob.valueOf('%PDF-1.4 test'),
      FirstPublishLocationId = parentId
    );
    insert version;
    return version;
  }

  private static List<String> fields(HttpRequest request) {
    return request.getBody().split('\\|');
  }

  private static IntakeTriggerSender.Target fakeTarget() {
    return new IntakeTriggerSender.Target(
      Id.valueOf('068000000000001'),
      Id.valueOf(
        Checklist_Item__c.SObjectType.getDescribe().getKeyPrefix() +
        '000000000001'
      )
    );
  }

  @IsTest
  static void attachingAFileToAChecklistItemSendsOneTrigger() {
    CaptureMock mock = new CaptureMock(202);
    Test.setMock(HttpCalloutMock.class, mock);
    Id itemId = item().Id;

    Test.startTest();
    ContentVersion version = upload(itemId);
    Test.stopTest();

    Assert.areEqual(
      1,
      mock.requests.size(),
      'One file on one checklist item sends one trigger'
    );
    HttpRequest sent = mock.requests[0];
    Assert.areEqual(
      'callout:Intake_Worker/hooks/salesforce',
      sent.getEndpoint()
    );
    Assert.areEqual('POST', sent.getMethod());
    Assert.areEqual('text/plain', sent.getHeader('Content-Type'));
    Assert.areEqual(
      IntakeTriggerSender.signatureFormula(sent.getBody()),
      sent.getHeader('X-Intake-Signature'),
      'The header signs exactly the body that is sent'
    );
    Assert.areEqual(String.valueOf(version.Id), fields(sent)[3]);
    Assert.areEqual(String.valueOf(itemId), fields(sent)[4]);
  }

  @IsTest
  static void attachingAFileToAnyOtherRecordSendsNothing() {
    CaptureMock mock = new CaptureMock(202);
    Test.setMock(HttpCalloutMock.class, mock);
    Id applicationId = [SELECT Id FROM Application__c LIMIT 1].Id;

    Test.startTest();
    upload(applicationId);
    Test.stopTest();

    Assert.areEqual(
      0,
      mock.requests.size(),
      'Only checklist items trigger review'
    );
  }

  @IsTest
  static void aNewVersionOfAnAttachedFileIsSentToo() {
    CaptureMock mock = new CaptureMock(202);
    Test.setMock(HttpCalloutMock.class, mock);
    Id itemId = item().Id;

    Test.startTest();
    ContentVersion first = upload(itemId);
    Id documentId = [
      SELECT ContentDocumentId
      FROM ContentVersion
      WHERE Id = :first.Id
    ]
    .ContentDocumentId;
    ContentVersion second = new ContentVersion(
      ContentDocumentId = documentId,
      Title = 'doc-0001',
      PathOnClient = 'doc-0001.pdf',
      VersionData = Blob.valueOf('%PDF-1.4 replaced')
    );
    insert second;
    Test.stopTest();

    Set<String> sentVersions = new Set<String>();
    for (HttpRequest request : mock.requests) {
      sentVersions.add(fields(request)[3]);
      Assert.areEqual(String.valueOf(itemId), fields(request)[4]);
    }
    Assert.areEqual(
      2,
      mock.requests.size(),
      'Each version gets its own trigger'
    );
    Assert.isTrue(sentVersions.contains(String.valueOf(first.Id)));
    Assert.isTrue(sentVersions.contains(String.valueOf(second.Id)));
  }

  @IsTest
  static void payloadCarriesVersionTimestampFreshNonceAndFullIds() {
    List<String> a = IntakeTriggerSender.buildPayload(fakeTarget(), 1800000000L)
      .split('\\|');
    List<String> b = IntakeTriggerSender.buildPayload(fakeTarget(), 1800000000L)
      .split('\\|');

    Assert.areEqual(5, a.size());
    Assert.areEqual('1', a[0]);
    Assert.areEqual('1800000000', a[1]);
    Assert.areEqual(36, a[2].length(), 'UUID nonce');
    Assert.areNotEqual(a[2], b[2], 'Every request gets a new nonce');
    Assert.areEqual(18, a[3].length(), 'Worker requires 18-character IDs');
    Assert.areEqual(18, a[4].length());
  }

  @IsTest
  static void formulaSignsThePayloadWithTheStoredKeyReference() {
    String payload = IntakeTriggerSender.buildPayload(
      fakeTarget(),
      1800000000L
    );
    String formula = IntakeTriggerSender.signatureFormula(payload);

    Assert.isTrue(
      formula.contains('BLOB(\'' + payload + '\')'),
      'Payload is the signed literal'
    );
    Assert.isTrue(
      formula.contains('$Credential.Intake_Signing.SigningKey'),
      'Key is referenced, never embedded'
    );
  }

  @IsTest
  static void unsafePayloadsAreRefusedBeforeBuildingAFormula() {
    for (
      String unsafe : new List<String>{
        '1|x\'|y',
        '1|}|y',
        '1|{!$Api}|y',
        '1|a b|c',
        null
      }
    ) {
      try {
        IntakeTriggerSender.signatureFormula(unsafe);
        Assert.fail('Should refuse: ' + unsafe);
      } catch (IllegalArgumentException e) {
        Assert.isNotNull(e.getMessage());
      }
    }
  }

  @IsTest
  static void duplicateTargetsInOneTransactionAreSentOnce() {
    CaptureMock mock = new CaptureMock(202);
    Test.setMock(HttpCalloutMock.class, mock);
    Id itemId = item().Id;

    Test.startTest();
    // Created without a parent so it doesn't send on its own.
    ContentVersion version = new ContentVersion(
      Title = 'x',
      PathOnClient = 'x.pdf',
      VersionData = Blob.valueOf('x')
    );
    insert version;
    IntakeTriggerSender.Target t = new IntakeTriggerSender.Target(
      version.Id,
      itemId
    );
    IntakeTriggerSender.enqueue(new List<IntakeTriggerSender.Target>{ t, t });
    Test.stopTest();

    Assert.areEqual(1, mock.requests.size());
  }

  @IsTest
  static void aRejectedSendIsLoggedNotThrown() {
    Test.setMock(HttpCalloutMock.class, new CaptureMock(401));

    Test.startTest();
    upload(item().Id); // Would fail the test if a non-202 response threw.
    Test.stopTest();

    Assert.isTrue(true, 'Reached without an exception');
  }

  @IsTest
  static void largeBatchesSendTheFirstChunkAndHandOffTheRest() {
    CaptureMock mock = new CaptureMock(202);
    Test.setMock(HttpCalloutMock.class, mock);
    String itemPrefix = Checklist_Item__c.SObjectType.getDescribe()
      .getKeyPrefix();
    List<IntakeTriggerSender.Target> targets = new List<IntakeTriggerSender.Target>();
    for (Integer i = 1; i <= 3; i++) {
      targets.add(
        new IntakeTriggerSender.Target(
          Id.valueOf('06800000000000' + i),
          Id.valueOf(itemPrefix + '00000000000' + i)
        )
      );
    }
    IntakeTriggerSender.batchSize = 2;

    Test.startTest();
    new IntakeTriggerSender(targets).execute(null);
    Test.stopTest();

    Assert.areEqual(2, mock.requests.size(), 'Only one batch per job');
    Assert.areEqual(
      1,
      IntakeTriggerSender.remainderForTest.size(),
      'The rest goes to the next job'
    );
  }
}
