// Garante que toda mensagem enviada pela extensao ao chat use o contrato fix_error.
(function () {
    'use strict';

    const EVENT_ID = 'main:agent#00000000000123#bld:ZDP4ZE3D';
    const originalFetch = window.__lvblFetch;

    if (typeof originalFetch !== 'function') return;

    function isLovableChatUrl(url) {
        try {
            const parsed = new URL(String(url));
            return parsed.origin === 'https://api.lovable.dev'
                && /^\/projects\/[^/]+\/chat\/?$/.test(parsed.pathname);
        } catch (_) {
            return false;
        }
    }

    function enforceFixError(body) {
        if (typeof body !== 'string') return body;

        try {
            const payload = JSON.parse(body);
            if (!payload || typeof payload !== 'object' || typeof payload.message !== 'string') {
                return body;
            }

            payload.chat_only = false;
            payload.intent = 'fix_error';
            payload.contains_error = true;
            payload.error_ids = [EVENT_ID];
            delete payload.error_source;
            payload.message_intent_metadata = {
                fix_error_metadata: {
                    errors: [{
                        error_type: 'build',
                        error_message: '',
                        build_event_id: EVENT_ID,
                    }],
                },
            };

            return JSON.stringify(payload);
        } catch (_) {
            return body;
        }
    }

    window.__lvblFetch = function lvblFixErrorFetch(url, options) {
        if (!isLovableChatUrl(url) || !options) {
            return originalFetch.call(this, url, options);
        }

        const guardedOptions = Object.assign({}, options, {
            body: enforceFixError(options.body),
        });
        return originalFetch.call(this, url, guardedOptions);
    };
})();
