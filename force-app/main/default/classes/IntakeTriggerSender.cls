/**
 * Sends the signed trigger to the intake Worker, one request per file version and checklist item.
 *
 * Signing: Salesforce evaluates SIGNATURE formula text when the request is sent, using the key
 * stored on the Intake_Signing external credential. This class only ever holds formula text,
 * never the key. The documented $Credential.<name>.Body field doesn't resolve in this org, so
 * the payload is placed in the formula as a literal and sent, unchanged, as the body.
 *
 * Best-effort by design: failures are logged with record IDs only, and a scheduled reconciler
 * (later in Phase 2) re-sends anything that never got a review.
 */
public without sharing class IntakeTriggerSender implements Queueable, Database.AllowsCallouts {
  public static final String ENDPOINT = 'callout:Intake_Worker/hooks/salesforce';

  // The payload is embedded in a quoted formula literal, so it may only contain characters
  // that can't end the literal or the formula: letters, digits, hyphens and the pipe separator.
  private static final Pattern SAFE_PAYLOAD = Pattern.compile(
    '^[A-Za-z0-9|-]+$'
  );

  // 20 callouts at a 5-second timeout stays under the 120-second callout limit per transaction.
  @TestVisible
  private static Integer batchSize = 20;
  private static final Integer TIMEOUT_MS = 5000;

  // Tests can't chain Queueables, so the remainder is exposed here instead.
  @TestVisible
  private static List<Target> remainderForTest;

  public class Target {
    public final Id contentVersionId;
    public final Id checklistItemId;

    public Target(Id contentVersionId, Id checklistItemId) {
      this.contentVersionId = contentVersionId;
      this.checklistItemId = checklistItemId;
    }

    public String key() {
      return String.valueOf(contentVersionId) +
        '|' +
        String.valueOf(checklistItemId);
    }
  }

  private final List<Target> targets;

  public IntakeTriggerSender(List<Target> targets) {
    this.targets = targets;
  }

  public static void enqueue(List<Target> candidates) {
    Map<String, Target> unique = new Map<String, Target>();
    for (Target t : candidates) {
      if (t.contentVersionId != null && t.checklistItemId != null) {
        unique.put(t.key(), t);
      }
    }
    if (!unique.isEmpty()) {
      System.enqueueJob(new IntakeTriggerSender(unique.values()));
    }
  }

  public void execute(QueueableContext context) {
    Integer count = Math.min(batchSize, targets.size());
    for (Integer i = 0; i < count; i++) {
      send(targets[i]);
    }

    if (targets.size() > count) {
      List<Target> rest = new List<Target>();
      for (Integer i = count; i < targets.size(); i++) {
        rest.add(targets[i]);
      }
      if (Test.isRunningTest()) {
        remainderForTest = rest;
      } else {
        System.enqueueJob(new IntakeTriggerSender(rest));
      }
    }
  }

  /** v|ts|nonce|contentVersionId|checklistItemId */
  @TestVisible
  private static String buildPayload(Target t, Long nowSeconds) {
    return String.join(
      new List<String>{
        '1',
        String.valueOf(nowSeconds),
        UUID.randomUUID().toString(),
        String.valueOf(t.contentVersionId),
        String.valueOf(t.checklistItemId)
      },
      '|'
    );
  }

  @TestVisible
  private static String signatureFormula(String payload) {
    if (payload == null || !SAFE_PAYLOAD.matcher(payload).matches()) {
      throw new IllegalArgumentException(
        'Payload contains characters that are unsafe in a formula literal'
      );
    }
    return '{!BASE64ENCODE(HMAC(\'SHA-256\', BLOB(\'' +
      payload +
      '\'), ' +
      'BLOB($Credential.Intake_Signing.SigningKey)))}';
  }

  private static void send(Target t) {
    String payload = buildPayload(t, Datetime.now().getTime() / 1000);
    String formula;
    try {
      formula = signatureFormula(payload);
    } catch (IllegalArgumentException e) {
      logFailure(t, 'unsafe_payload');
      return;
    }

    HttpRequest request = new HttpRequest();
    request.setEndpoint(ENDPOINT);
    request.setMethod('POST');
    request.setHeader('Content-Type', 'text/plain');
    request.setHeader('X-Intake-Signature', formula);
    request.setTimeout(TIMEOUT_MS);
    request.setBody(payload);

    try {
      HttpResponse response = new Http().send(request);
      if (response.getStatusCode() != 202) {
        logFailure(t, 'status_' + response.getStatusCode());
      }
    } catch (CalloutException e) {
      logFailure(t, 'callout_exception');
    }
  }

  private static void logFailure(Target t, String reason) {
    System.debug(
      LoggingLevel.ERROR,
      'intake_trigger_failed reason=' +
        reason +
        ' contentVersionId=' +
        t.contentVersionId +
        ' checklistItemId=' +
        t.checklistItemId
    );
  }
}
