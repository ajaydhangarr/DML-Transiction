/* global window, Worker */
(function () {
    'use strict';

    const CHANNEL = 'DML_LOG_PARSER_FRAME_V1';
    const parentOrigin = window.location.origin;
    let parserWorker = null;
    let activeRequestId = null;

    function send(message) {
        window.parent.postMessage({ channel: CHANNEL, ...message }, parentOrigin);
    }

    function destroyWorker() {
        if (parserWorker) parserWorker.terminate();
        parserWorker = null;
        activeRequestId = null;
    }

    function createWorker() {
        if (parserWorker) return parserWorker;

        const worker = new Worker('./dmlLogWorker.js');
        worker.onmessage = (event) => {
            const message = event.data || {};
            if (message.type === 'READY') return;
            send(message);
            if (message.type === 'RESULT' || message.type === 'CANCELLED' || message.type === 'ERROR') {
                activeRequestId = null;
            }
        };
        worker.onerror = (event) => {
            send({
                type: 'ERROR',
                requestId: activeRequestId,
                code: 'WORKER_RUNTIME',
                phase: 'worker',
                message: event?.message || 'The local parser failed while reading the file. Refresh the page and try again.'
            });
            destroyWorker();
        };
        parserWorker = worker;
        return worker;
    }

    window.addEventListener('message', (event) => {
        if (event.source !== window.parent || event.origin !== parentOrigin) return;
        const message = event.data || {};
        if (message.channel !== CHANNEL || !message.type) return;

        try {
            if (message.type === 'RESET') {
                destroyWorker();
                send({ type: 'RESET_DONE', requestId: message.requestId });
                return;
            }

            if (message.type === 'CANCEL') {
                if (parserWorker && message.requestId) {
                    parserWorker.postMessage({ type: 'CANCEL', requestId: message.requestId });
                }
                return;
            }

            const worker = createWorker();
            activeRequestId = message.requestId || null;

            if (message.type === 'INDEX_FILE') {
                worker.postMessage({
                    type: 'INDEX_FILE',
                    requestId: message.requestId,
                    file: message.file
                });
            } else if (message.type === 'PARSE_SCOPE') {
                worker.postMessage({
                    type: 'PARSE_SCOPE',
                    requestId: message.requestId,
                    scope: message.scope
                });
            }
        } catch (error) {
            send({
                type: 'ERROR',
                requestId: message.requestId,
                code: 'PARSER_START',
                phase: 'bridge',
                message: error?.message || 'The local parser could not start. Please refresh the page and try again.'
            });
            destroyWorker();
        }
    });

    send({ type: 'READY' });
}());
