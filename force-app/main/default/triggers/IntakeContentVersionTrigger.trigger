trigger IntakeContentVersionTrigger on ContentVersion(after insert) {
  IntakeTriggerHandler.onVersionsInserted(Trigger.new);
}
