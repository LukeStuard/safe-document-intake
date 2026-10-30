trigger IntakeContentDocumentLinkTrigger on ContentDocumentLink(after insert) {
  IntakeTriggerHandler.onLinksInserted(Trigger.new);
}
