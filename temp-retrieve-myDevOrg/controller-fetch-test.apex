try {
    String body = dmlviz.DebugLogController.fetchLogBody('07Lg500000D8GplEAF');
    System.debug(LoggingLevel.ERROR, 'CONTROLLER_FETCH_SUCCESS; BODY_LENGTH=' + (body == null ? 0 : body.length()));
} catch (Exception ex) {
    System.debug(LoggingLevel.ERROR, 'CONTROLLER_FETCH_ERROR=' + ex.getTypeName() + ': ' + ex.getMessage());
}
