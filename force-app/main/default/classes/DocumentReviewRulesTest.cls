/**
 * Proves the Document_Review__c rules hold. Each test tries something the brief says
 * must be impossible and expects Salesforce to block it.
 *
 * This org enforces field permissions on Apex DML, so the running admin gets Intake_Admin
 * (full field access). Tests that run as the admin therefore exercise the validation rules
 * on their own: the layer that still holds if field permissions are ever misconfigured.
 * fieldPermissionsAlsoBlockPipeline proves the permission layer separately.
 */
@IsTest
private class DocumentReviewRulesTest {
  private static final String MODEL = 'gemini-3.5-flash-lite';
  private static final String DOMAIN = '@intake.test';

  @TestSetup
  static void setup() {
    Profile p = [SELECT Id FROM Profile WHERE Name = 'Standard User' LIMIT 1];
    String suffix = String.valueOf(Math.abs(Crypto.getRandomInteger()));
    User pipeline = makeUser(p.Id, 'intpipe', 'pipeline' + suffix);
    User reviewer = makeUser(p.Id, 'intrev', 'reviewer' + suffix);

    // Setup objects (users, permission set assignments) go in their own runAs block
    // to avoid mixed DML errors with the data records below.
    System.runAs(new User(Id = UserInfo.getUserId())) {
      insert new List<User>{ pipeline, reviewer };
      Map<String, Id> sets = new Map<String, Id>();
      for (PermissionSet s : [
        SELECT Id, Name
        FROM PermissionSet
        WHERE Name IN ('Intake_Integration', 'Intake_Reviewer', 'Intake_Admin')
      ]) {
        sets.put(s.Name, s.Id);
      }
      insert new List<PermissionSetAssignment>{
        new PermissionSetAssignment(
          AssigneeId = pipeline.Id,
          PermissionSetId = sets.get('Intake_Integration')
        ),
        new PermissionSetAssignment(
          AssigneeId = reviewer.Id,
          PermissionSetId = sets.get('Intake_Reviewer')
        )
      };
      if (
        [
          SELECT COUNT()
          FROM PermissionSetAssignment
          WHERE
            AssigneeId = :UserInfo.getUserId()
            AND PermissionSetId = :sets.get('Intake_Admin')
        ] == 0
      ) {
        insert new PermissionSetAssignment(
          AssigneeId = UserInfo.getUserId(),
          PermissionSetId = sets.get('Intake_Admin')
        );
      }
    }

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

  // ---------- Separation of duties ----------

  @IsTest
  static void pipelineCannotDecideItsOwnReview() {
    // End to end: the pipeline is stopped, by whichever layer gets there first.
    Document_Review__c r = pipelineCreates('068000000000001AAA');
    Test.startTest();
    expectUpdateBlocked(
      new Document_Review__c(Id = r.Id, Decision__c = 'Approved'),
      pipelineUser(),
      null
    );
    Test.stopTest();
    assertDecision(r.Id, 'Pending');
  }

  @IsTest
  static void creatorCannotDecideEvenWithFullAccess() {
    // The admin has edit access to every field, so only Pipeline_Cannot_Decide can stop this.
    Document_Review__c r = review('068000000000012AAA');
    insert r;
    Test.startTest();
    expectUpdateBlocked(
      new Document_Review__c(Id = r.Id, Decision__c = 'Approved'),
      null,
      'decide a review you created'
    );
    Test.stopTest();
    assertDecision(r.Id, 'Pending');
  }

  @IsTest
  static void fieldPermissionsAlsoBlockPipeline() {
    // Created by the admin, so Pipeline_Cannot_Decide does not apply here.
    // Only the permission layer stands between the pipeline user and the decision.
    Document_Review__c r = review('068000000000002AAA');
    insert r;
    Boolean blocked = false;
    Test.startTest();
    System.runAs(pipelineUser()) {
      try {
        Database.update(
          new Document_Review__c(Id = r.Id, Decision__c = 'Approved'),
          AccessLevel.USER_MODE
        );
      } catch (Exception e) {
        blocked = true;
        Assert.isFalse(
          e.getMessage().contains('decide a review you created'),
          'Expected the permission layer to block this, not the validation rule: ' +
          e.getMessage()
        );
      }
    }
    Test.stopTest();
    Assert.isTrue(
      blocked,
      'Pipeline user edited a review in user mode; field permissions are too broad.'
    );
    assertDecision(r.Id, 'Pending');
  }

  @IsTest
  static void differentReviewerCanDecideAndIsStamped() {
    Document_Review__c r = pipelineCreates('068000000000003AAA');
    User reviewer = reviewerUser();
    Test.startTest();
    System.runAs(reviewer) {
      update new Document_Review__c(Id = r.Id, Decision__c = 'Approved');
    }
    Test.stopTest();
    Document_Review__c after = reload(r.Id);
    Assert.areEqual('Approved', after.Decision__c);
    Assert.areEqual(
      reviewer.Id,
      after.Decided_By__c,
      'Stamp flow should record the reviewer.'
    );
    Assert.isNotNull(after.Decided_On__c, 'Stamp flow should record the time.');
  }

  // ---------- Finality ----------

  @IsTest
  static void decisionIsFinal() {
    Document_Review__c r = pipelineCreates('068000000000004AAA');
    User reviewer = reviewerUser();
    System.runAs(reviewer) {
      update new Document_Review__c(Id = r.Id, Decision__c = 'Approved');
    }
    Test.startTest();
    expectUpdateBlocked(
      new Document_Review__c(
        Id = r.Id,
        Decision__c = 'Rejected',
        Decision_Note__c = 'Changed my mind.'
      ),
      reviewer,
      'already been decided'
    );
    expectUpdateBlocked(
      new Document_Review__c(
        Id = r.Id,
        Decision_Note__c = 'Rewriting history.'
      ),
      reviewer,
      'already been decided'
    );
    Test.stopTest();
    assertDecision(r.Id, 'Approved');
  }

  // ---------- Immutable verdict ----------

  @IsTest
  static void verdictIsImmutableEvenForAdmins() {
    Document_Review__c r = pipelineCreates('068000000000005AAA');
    Test.startTest();
    // Runs as the admin who owns the test, with full system access.
    expectUpdateBlocked(
      new Document_Review__c(Id = r.Id, Verdict__c = 'wrong_type'),
      null,
      'first-pass verdict'
    );
    expectUpdateBlocked(
      new Document_Review__c(Id = r.Id, Reasons__c = 'Edited reasons.'),
      null,
      'first-pass verdict'
    );
    expectUpdateBlocked(
      new Document_Review__c(Id = r.Id, Model__c = 'some-other-model'),
      null,
      'first-pass verdict'
    );
    expectUpdateBlocked(
      new Document_Review__c(Id = r.Id, Tampering_Excerpt__c = 'Planted text.'),
      null,
      'first-pass verdict'
    );
    Test.stopTest();
    Assert.areEqual('pass', reload(r.Id).Verdict__c);
  }

  // ---------- Decision stamp ----------

  @IsTest
  static void decisionStampCannotBeHandEdited() {
    Document_Review__c r = pipelineCreates('068000000000006AAA');
    Test.startTest();
    expectUpdateBlocked(
      new Document_Review__c(Id = r.Id, Decided_By__c = UserInfo.getUserId()),
      null,
      'recorded automatically'
    );
    expectUpdateBlocked(
      new Document_Review__c(Id = r.Id, Decided_On__c = System.now()),
      null,
      'recorded automatically'
    );
    Test.stopTest();
    Assert.isNull(reload(r.Id).Decided_By__c);
  }

  // ---------- Rejection reason ----------

  @IsTest
  static void rejectionNeedsNote() {
    Document_Review__c r = pipelineCreates('068000000000007AAA');
    User reviewer = reviewerUser();
    Test.startTest();
    expectUpdateBlocked(
      new Document_Review__c(Id = r.Id, Decision__c = 'Rejected'),
      reviewer,
      'explaining the rejection'
    );
    System.runAs(reviewer) {
      update new Document_Review__c(
        Id = r.Id,
        Decision__c = 'Rejected',
        Decision_Note__c = 'Transcript belongs to a different applicant.'
      );
    }
    Test.stopTest();
    assertDecision(r.Id, 'Rejected');
  }

  // ---------- Creation rules ----------

  @IsTest
  static void newReviewMustBePending() {
    Document_Review__c preDecided = review('068000000000008AAA');
    preDecided.Decision__c = 'Approved';
    Document_Review__c noModel = review('068000000000009AAA');
    noModel.Model__c = null;
    Document_Review__c preStamped = review('068000000000010AAA');
    preStamped.Decided_By__c = UserInfo.getUserId();

    Test.startTest();
    expectInsertBlocked(preDecided, 'must be Pending');
    expectInsertBlocked(noModel, 'must be Pending');
    expectInsertBlocked(preStamped, 'must be Pending');
    Test.stopTest();
    Assert.areEqual(0, [SELECT COUNT() FROM Document_Review__c]);
  }

  @IsTest
  static void duplicateFileVersionIsRejected() {
    pipelineCreates('068000000000011AAA');
    Boolean blocked = false;
    Test.startTest();
    System.runAs(pipelineUser()) {
      try {
        insert review('068000000000011AAA');
      } catch (DmlException e) {
        blocked = true;
        Assert.areEqual(
          StatusCode.DUPLICATE_VALUE,
          e.getDmlType(0),
          e.getMessage()
        );
      }
    }
    Test.stopTest();
    Assert.isTrue(
      blocked,
      'A replayed job created a second review for the same file version.'
    );
  }

  // ---------- Helpers ----------

  private static Document_Review__c review(String contentVersionId) {
    return new Document_Review__c(
      Checklist_Item__c = [SELECT Id FROM Checklist_Item__c LIMIT 1]
      .Id,
      Content_Version_Id__c = contentVersionId,
      Model__c = MODEL,
      Verdict__c = 'pass',
      Reasons__c = 'Synthetic test review.'
    );
  }

  private static Document_Review__c pipelineCreates(String contentVersionId) {
    Document_Review__c r = review(contentVersionId);
    System.runAs(pipelineUser()) {
      insert r;
    }
    return r;
  }

  /**
   * Runs the update as the given user (or the test's admin when null) and expects it to be stopped.
   * With an expectedMessage, the error must come from that specific rule; with null, any block counts.
   */
  private static void expectUpdateBlocked(
    Document_Review__c change,
    User asUser,
    String expectedMessage
  ) {
    Boolean blocked = false;
    try {
      if (asUser == null) {
        update change;
      } else {
        System.runAs(asUser) {
          update change;
        }
      }
    } catch (Exception e) {
      blocked = true;
      if (expectedMessage != null) {
        Assert.isTrue(
          e.getMessage().contains(expectedMessage),
          'Blocked, but by the wrong rule. Expected "' +
            expectedMessage +
            '", got: ' +
            e.getMessage()
        );
      }
    }
    Assert.isTrue(
      blocked,
      'Update was allowed but should have been blocked: ' + expectedMessage
    );
  }

  private static void expectInsertBlocked(
    Document_Review__c rec,
    String expectedMessage
  ) {
    Boolean blocked = false;
    try {
      insert rec;
    } catch (DmlException e) {
      blocked = true;
      Assert.isTrue(
        e.getMessage().contains(expectedMessage),
        'Blocked, but by the wrong rule. Expected "' +
          expectedMessage +
          '", got: ' +
          e.getMessage()
      );
    }
    Assert.isTrue(
      blocked,
      'Insert was allowed but should have been blocked: ' + expectedMessage
    );
  }

  private static Document_Review__c reload(Id reviewId) {
    return [
      SELECT Decision__c, Decided_By__c, Decided_On__c, Verdict__c
      FROM Document_Review__c
      WHERE Id = :reviewId
    ];
  }

  private static void assertDecision(Id reviewId, String expected) {
    Assert.areEqual(expected, reload(reviewId).Decision__c);
  }

  private static User pipelineUser() {
    return [
      SELECT Id
      FROM User
      WHERE Alias = 'intpipe' AND Username LIKE :('%' + DOMAIN)
      LIMIT 1
    ];
  }

  private static User reviewerUser() {
    return [
      SELECT Id
      FROM User
      WHERE Alias = 'intrev' AND Username LIKE :('%' + DOMAIN)
      LIMIT 1
    ];
  }

  private static User makeUser(Id profileId, String alias, String name) {
    return new User(
      ProfileId = profileId,
      Alias = alias,
      Username = name + DOMAIN,
      Email = name + DOMAIN,
      LastName = name,
      TimeZoneSidKey = 'America/Los_Angeles',
      LocaleSidKey = 'en_US',
      EmailEncodingKey = 'UTF-8',
      LanguageLocaleKey = 'en_US'
    );
  }
}
