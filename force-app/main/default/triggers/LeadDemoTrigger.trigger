trigger LeadDemoTrigger on Lead (before insert, after insert) {
    if (Trigger.isBefore) {
        // Call Apex helper class method with debug statements
        LeadTestHelper.performTestOperations(Trigger.new);

        for (Lead ld : Trigger.new) {
            if (ld.Company == 'FAIL_VALIDATION') {
                ld.addError('Custom Validation Error: Company cannot be FAIL_VALIDATION.');
            }
        }
    }

    if (Trigger.isAfter) {
        // 1. SOQL Query Execution
        List<Lead> recentLeads = [SELECT Id, Company, Status FROM Lead ORDER BY CreatedDate DESC LIMIT 5];

        // 2. SOSL Search Execution
        List<List<SObject>> searchResults = [FIND 'Demo' IN ALL FIELDS RETURNING Lead(Id, Company)];

        // 3. Nested DML (Task Insertion for each created Lead)
        List<Task> tasksToInsert = new List<Task>();
        for (Lead ld : Trigger.new) {
            tasksToInsert.add(new Task(
                Subject = 'Follow up with Demo Lead: ' + ld.LastName,
                WhoId = ld.Id,
                Status = 'Not Started',
                Priority = 'High'
            ));
        }

        if (!tasksToInsert.isEmpty()) {
            insert tasksToInsert;
        }
    }
}
