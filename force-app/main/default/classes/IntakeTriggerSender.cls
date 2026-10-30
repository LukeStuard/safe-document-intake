/**
 * Sends the signed trigger to the intake Worker, one request per file version and checklist item.
 * The Named Credential signs each request on the way out; this class never sees the key.
 *
 * Best-effort by design: failures are logged with record IDs only, and a scheduled reconciler
 * (later in Phase 2) re-sends anything that never got a review.
 */
public without sharing class IntakeTriggerSender implements Queueable, Database.AllowsCallouts {
  public static final String ENDPOINT = 'callout:Intake_Worker/hooks/salesforce';

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

  @TestVisible
  private static String buildBody(Target t, Long nowSeconds) {
    return JSON.serialize(
      new Map<String, Object>{
        'v' => 1,
        'ts' => nowSeconds,
        'nonce' => UUID.randomUUID().toString(),
        'contentVersionId' => String.valueOf(t.contentVersionId),
        'checklistItemId' => String.valueOf(t.checklistItemId)
      }
    );
  }

  private static void send(Target t) {
    HttpRequest request = new HttpRequest();
    request.setEndpoint(ENDPOINT);
    request.setMethod('POST');
    request.setHeader('Content-Type', 'application/json');
    request.setTimeout(TIMEOUT_MS);
    request.setBody(buildBody(t, Datetime.now().getTime() / 1000));

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
