/**
 * Finds file versions that landed on a checklist item and hands their IDs to the sender.
 * Two paths: a file attached (new link), or a new version of a file that's already attached.
 *
 * Without sharing: a reviewer's upload must still be sent even if they can't see every link
 * on the document. This class reads record IDs only and passes on record IDs only.
 */
public without sharing class IntakeTriggerHandler {
  public static void onLinksInserted(List<ContentDocumentLink> links) {
    Map<Id, Set<Id>> itemsByDocument = new Map<Id, Set<Id>>();
    for (ContentDocumentLink link : links) {
      if (isChecklistItem(link.LinkedEntityId)) {
        if (!itemsByDocument.containsKey(link.ContentDocumentId)) {
          itemsByDocument.put(link.ContentDocumentId, new Set<Id>());
        }
        itemsByDocument.get(link.ContentDocumentId).add(link.LinkedEntityId);
      }
    }
    if (itemsByDocument.isEmpty()) {
      return;
    }

    List<IntakeTriggerSender.Target> targets = new List<IntakeTriggerSender.Target>();
    for (ContentDocument doc : [
      SELECT Id, LatestPublishedVersionId
      FROM ContentDocument
      WHERE Id IN :itemsByDocument.keySet()
    ]) {
      for (Id itemId : itemsByDocument.get(doc.Id)) {
        targets.add(
          new IntakeTriggerSender.Target(doc.LatestPublishedVersionId, itemId)
        );
      }
    }
    IntakeTriggerSender.enqueue(targets);
  }

  public static void onVersionsInserted(List<ContentVersion> versions) {
    // Version 1 arrives with its link, so the link path already covers it.
    Map<Id, Id> newVersionByDocument = new Map<Id, Id>();
    for (ContentVersion version : versions) {
      if (version.VersionNumber != null && version.VersionNumber != '1') {
        newVersionByDocument.put(version.ContentDocumentId, version.Id);
      }
    }
    if (newVersionByDocument.isEmpty()) {
      return;
    }

    List<IntakeTriggerSender.Target> targets = new List<IntakeTriggerSender.Target>();
    for (ContentDocumentLink link : [
      SELECT ContentDocumentId, LinkedEntityId
      FROM ContentDocumentLink
      WHERE ContentDocumentId IN :newVersionByDocument.keySet()
    ]) {
      if (isChecklistItem(link.LinkedEntityId)) {
        targets.add(
          new IntakeTriggerSender.Target(
            newVersionByDocument.get(link.ContentDocumentId),
            link.LinkedEntityId
          )
        );
      }
    }
    IntakeTriggerSender.enqueue(targets);
  }

  private static Boolean isChecklistItem(Id recordId) {
    return recordId != null &&
      recordId.getSObjectType() == Checklist_Item__c.SObjectType;
  }
}
