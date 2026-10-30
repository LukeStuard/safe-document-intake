@IsTest
private class IntakeTriggerSenderTest {
  // Records every callout instead of sending it. Apex tests can't reach the network,
  // and the Named Credential's signature formula isn't evaluated in tests, so these
  // tests prove what gets sent and when. The signature is proven end to end in the org.
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

  private static Map<String, Object> body(HttpRequest request) {
    return (Map<String, Object>) JSON.deserializeUntyped(request.getBody());
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
    Assert.areEqual('application/json', sent.getHeader('Content-Type'));
    Assert.areEqual(
      String.valueOf(version.Id),
      body(sent).get('contentVersionId')
    );
    Assert.areEqual(String.valueOf(itemId), body(sent).get('checklistItemId'));
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

    Set<Object> sentVersions = new Set<Object>();
    for (HttpRequest request : mock.requests) {
      sentVersions.add(body(request).get('contentVersionId'));
      Assert.areEqual(
        String.valueOf(itemId),
        body(request).get('checklistItemId')
      );
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
  static void bodyCarriesVersionTimestampFreshNonceAndFullIds() {
    IntakeTriggerSender.Target t = new IntakeTriggerSender.Target(
      Id.valueOf('068000000000001'),
      Id.valueOf(
        Checklist_Item__c.SObjectType.getDescribe().getKeyPrefix() +
        '000000000001'
      )
    );

    Map<String, Object> a = (Map<String, Object>) JSON.deserializeUntyped(
      IntakeTriggerSender.buildBody(t, 1800000000L)
    );
    Map<String, Object> b = (Map<String, Object>) JSON.deserializeUntyped(
      IntakeTriggerSender.buildBody(t, 1800000000L)
    );

    Assert.areEqual(1, a.get('v'));
    Assert.areEqual(1800000000L, (Long) a.get('ts'));
    Assert.areEqual(36, ((String) a.get('nonce')).length(), 'UUID nonce');
    Assert.areNotEqual(
      a.get('nonce'),
      b.get('nonce'),
      'Every request gets a new nonce'
    );
    Assert.areEqual(
      18,
      ((String) a.get('contentVersionId')).length(),
      'Worker requires 18-character IDs'
    );
    Assert.areEqual(18, ((String) a.get('checklistItemId')).length());
  }

  @IsTest
  static void duplicateTargetsInOneTransactionAreSentOnce() {
    CaptureMock mock = new CaptureMock(202);
    Test.setMock(HttpCalloutMock.class, mock);
    ContentVersion version;
    Id itemId = item().Id;

    Test.startTest();
    // Created without a parent so it doesn't send on its own.
    version = new ContentVersion(
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
