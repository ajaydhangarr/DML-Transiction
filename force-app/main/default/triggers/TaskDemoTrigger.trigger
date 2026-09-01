trigger TaskDemoTrigger on Task (after insert) {
    if (Trigger.isAfter) {
        // 3rd level SOQL execution to demonstrate deep nested hierarchy
        List<Task> openTasks = [SELECT Id, Subject, Status FROM Task WHERE Status = 'Not Started' ORDER BY CreatedDate DESC LIMIT 5];
        System.debug('TaskDemoTrigger executed for ' + Trigger.new.size() + ' task(s).');
    }
}
