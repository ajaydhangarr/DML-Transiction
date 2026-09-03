try {
    HttpRequest request = new HttpRequest();
    request.setEndpoint('callout:DML_Tooling/services/data/v67.0/tooling/sobjects/ApexLog/07Lg500000D8GplEAF/Body');
    request.setMethod('GET');
    request.setTimeout(120000);
    HttpResponse response = new Http().send(request);
    String body = response.getBody();
    System.debug(LoggingLevel.ERROR, 'DML_TOOLING_STATUS=' + response.getStatusCode() + '; BODY_LENGTH=' + (body == null ? 0 : body.length()));
} catch (Exception ex) {
    System.debug(LoggingLevel.ERROR, 'DML_TOOLING_ERROR=' + ex.getTypeName() + ': ' + ex.getMessage());
}
