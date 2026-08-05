// Roda no contexto da página. Quando window.__lvblForceFree === true,
// intercepta o próximo POST para api.lovable.dev que contenha um "message"
// e reescreve o body adicionando o truque de intent:'fix_error' — mesmo
// método que a extensão usa para enviar prompts sem gastar créditos.
(function () {
    'use strict';
    if (window.__lvblFetchPatched) return;
    window.__lvblFetchPatched = true;

    const FALLBACK_EVENT_ID = 'main:agent#00000000000123#bld:ZDP4ZE3D';

    function shouldPatch(url) {
        try {
            const u = typeof url === 'string' ? url : (url && url.url) || '';
            return /(^|\/\/)api\.lovable\.dev\//.test(u) || /lovable\.dev\/api\//.test(u);
        } catch (_) { return false; }
    }

    function rewriteBody(bodyText) {
        try {
            const obj = JSON.parse(bodyText);
            if (!obj || typeof obj !== 'object') return bodyText;
            // Só reescreve se parece um envio de chat (tem "message" e não é fix_error ainda)
            if (typeof obj.message !== 'string') return bodyText;
            obj.chat_only = false;
            obj.intent = 'fix_error';
            obj.contains_error = true;
            obj.error_ids = [FALLBACK_EVENT_ID];
            delete obj.error_source;
            obj.message_intent_metadata = {
                fix_error_metadata: {
                    errors: [{
                        error_type: 'build',
                        error_message: '',
                        build_event_id: FALLBACK_EVENT_ID,
                    }],
                },
            };
            try { window.__lvblForceFree = false; } catch (_) {}
            console.log('[lvbl-page-patch] rewrote outgoing request as free (fix_error)');
            return JSON.stringify(obj);
        } catch (_) { return bodyText; }
    }

    const _fetch = window.fetch;
    window.fetch = function (input, init) {
        try {
            if (window.__lvblForceFree && shouldPatch(input) && init && init.body && typeof init.body === 'string') {
                init = Object.assign({}, init, { body: rewriteBody(init.body) });
            } else if (window.__lvblForceFree && input instanceof Request) {
                const req = input;
                if (shouldPatch(req.url) && (req.method || 'GET').toUpperCase() === 'POST') {
                    return req.clone().text().then((txt) => {
                        const newBody = rewriteBody(txt);
                        const newReq = new Request(req.url, {
                            method: req.method,
                            headers: req.headers,
                            body: newBody,
                            credentials: req.credentials,
                            mode: req.mode,
                            cache: req.cache,
                            redirect: req.redirect,
                            referrer: req.referrer,
                            integrity: req.integrity,
                        });
                        return _fetch.call(window, newReq, init);
                    });
                }
            }
        } catch (_) {}
        return _fetch.call(window, input, init);
    };

    const _xhrOpen = XMLHttpRequest.prototype.open;
    const _xhrSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
        this.__lvblUrl = url;
        this.__lvblMethod = method;
        return _xhrOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
        try {
            if (window.__lvblForceFree && (this.__lvblMethod || '').toUpperCase() === 'POST'
                && shouldPatch(this.__lvblUrl) && typeof body === 'string') {
                body = rewriteBody(body);
            }
        } catch (_) {}
        return _xhrSend.call(this, body);
    };

    console.log('[lvbl-page-patch] fetch/XHR patch installed');
})();
