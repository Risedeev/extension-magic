// Utility functions - usando Web Crypto API nativa do navegador
function generateRandomId(length = 10) {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

function timeSortableId() {
    //const time = Date.now().toString(36); // tempo ordenável
    const random = generateRandomHex(3); // 3 bytes = 6 caracteres hex
    return `${random}`;
}

function randomFourId() {
    return generateRandomHex(2); // 2 bytes = 4 caracteres hex
}

// Função para gerar bytes aleatórios usando Web Crypto API
function generateRandomHex(bytes) {
    const array = new Uint8Array(bytes);
    crypto.getRandomValues(array);
    return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
}

function generateMessageId() {
    const r = timeSortableId();
    const r2 = randomFourId();
    return {
        userMessageId: `umsg_01ktevtptd${r2}s0d2${r}x8cq70a${generateRandomId(4)}`,
        aiMessageId: `aimsg_01ktevtpvh${r}7n2rj62vz7`
        
    };
}

// State management
class ChatState {
    constructor() {
        this.messages = [];
        this.files = [];
        this.projectId = null;
        this.token = null;
        this.cookieString = null;
        this.browserSessionId = null;
    }

    addMessage(type, content, files = []) {
        const message = {
            id: Date.now().toString(),
            type: type,
            content: content,
            files: files,
            timestamp: new Date().toISOString()
        };
        this.messages.push(message);
        return message;
    }
}

const state = new ChatState();

// DOM Elements
const chatContainer = document.getElementById('chatContainer');
const messagesContainer = document.getElementById('messages');
const messageInput = document.getElementById('messageInput');
const sendButton = document.getElementById('sendButton');
const attachButton = document.getElementById('attachButton');
const fileInput = document.getElementById('fileInput');
const filePreview = document.getElementById('filePreview');
const statusBar = document.getElementById('statusBar');
const projectIdElement = document.getElementById('projectId');

// Initialize extension
async function initialize() {
    try {
        statusBar.textContent = 'Inicializando...';
        
        // Get current tab
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        
        if (!tab.url || !tab.url.includes('lovable.dev')) {
            throw new Error('Abra a extensão em uma página do Lovable.dev');
        }

        // Extract project ID (aceita /projects/<id>, /projects/<id>/..., com ou sem query/hash)
        const projectMatch = tab.url.match(/\/projects\/([^\/?#]+)/);
        if (!projectMatch) {
            throw new Error('Abra um projeto (/projects/...) no Lovable.dev antes de usar a extensão');
        }
        state.projectId = projectMatch[1];
        projectIdElement.textContent = `Projeto: ${state.projectId}`;

        // Get auth data
        await getAuthData(tab.url);
        
        statusBar.textContent = 'Pronto para usar';
        statusBar.classList.remove('error');
    } catch (error) {
        statusBar.textContent = error.message;
        statusBar.classList.add('error');
        console.error('Initialization error:', error);
    }
}

async function getAuthData(url) {
    try {
        // Get all cookies from lovable.dev domain
        const cookies = await chrome.cookies.getAll({
            domain: 'lovable.dev'
        });
        
        if (cookies.length === 0) {
            // Try without domain specification
            const allCookies = await chrome.cookies.getAll({});
            const lovableCookies = allCookies.filter(c => 
                c.domain.includes('lovable.dev')
            );
            
            if (lovableCookies.length === 0) {
                throw new Error('Cookies não encontrados. Faça login no Lovable.dev primeiro.');
            }
            
            // Find session token
            const sessionCookie = lovableCookies.find(c => 
                c.name === 'lovable-session-id-v2' || 
                c.name.includes('session')
            );
            
            if (!sessionCookie) {
                throw new Error('Token de sessão não encontrado. Faça login novamente.');
            }
            
            state.token = sessionCookie.value;
            
            // Build cookie string
            state.cookieString = lovableCookies
                .map(c => `${c.name}=${c.value}`)
                .join('; ');
            
            // Generate browser session ID if not found
            const browserSessionCookie = lovableCookies.find(c => c.name === 'x-browser-session-id');
            state.browserSessionId = browserSessionCookie?.value || `bsess_${generateRandomId(26)}`;
            
        } else {
            // Find session token
            const sessionCookie = cookies.find(c => 
                c.name === 'lovable-session-id-v2' || 
                c.name.includes('session') ||
                c.name === 'sb-access-token'
            );
            
            if (!sessionCookie) {
                console.log('Available cookies:', cookies.map(c => c.name));
                throw new Error('Token de sessão não encontrado. Cookies disponíveis: ' + 
                    cookies.map(c => c.name).join(', '));
            }
            
            state.token = sessionCookie.value;
            
            // Build cookie string
            state.cookieString = cookies
                .map(c => `${c.name}=${c.value}`)
                .join('; ');
            
            // Generate browser session ID if not found
            state.browserSessionId = `bsess_${generateRandomId(26)}`;
        }
        
        console.log('Authentication successful');
        console.log('Token length:', state.token.length);
        console.log('Cookies string length:', state.cookieString.length);
        
    } catch (error) {
        console.error('Auth error:', error);
        throw new Error(`Erro de autenticação: ${error.message}`);
    }
}

// File handling
class FileAttachment {
    constructor(file) {
        this.id = Date.now().toString() + Math.random().toString(36).substr(2, 9);
        this.file = file;
        this.preview = '';
        this.url = '';
        this.file_id = '';
        this.file_name = file.name;
        this.uploading = false;
        this.isImage = file.type.startsWith('image/');
    }

    async generatePreview() {
        if (this.isImage) {
            return new Promise((resolve) => {
                const reader = new FileReader();
                reader.onload = (e) => {
                    this.preview = e.target.result;
                    resolve();
                };
                reader.readAsDataURL(this.file);
            });
        }
    }

    async upload(state) {
    try {
        this.uploading = true;
        updateFilePreviewStatus(this.id, 'uploading');
        
        // Step 1: Generate upload URL
        const uploadUrlResponse = await fetch(
            `https://api.lovable.dev/projects/${state.projectId}/files/generate-upload-url`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${state.token}`,
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
                    'Origin': 'https://lovable.dev',
                    'Referer': 'https://lovable.dev/',
                    'Cookie': state.cookieString,
                    'x-client-git-sha': '04b3668677038d15039de65e27688c38ab80e9ab',
                    'x-browser-session-id': state.browserSessionId,
                    'x-lov-platform': '{"platform":"web","version":"96d78a825f60be3df0ab1bd832c8f511eb4b5775"}'
                },
                body: JSON.stringify({
                    original_file_name: this.file.name,
                    content_type: this.file.type,
                    file_size_bytes: this.file.size,
                    original_file_size_bytes: this.file.size
                })
            }
        );

        if (!uploadUrlResponse.ok) {
            const errorText = await uploadUrlResponse.text();
            console.error('Upload URL error:', errorText);
            throw new Error(`Falha ao gerar URL de upload: ${uploadUrlResponse.status}`);
        }

        const uploadData = await uploadUrlResponse.json();
        
        // Extract file info
        const dir_name = uploadData.file_id.split('/')[0];
        const file_name = uploadData.file_id.split('/')[1];
        
        // Step 2: Upload to Google Cloud Storage
        // Usar XMLHttpRequest para evitar problemas de CORS
        const fileBuffer = await this.file.arrayBuffer();
        
        // Tentar upload direto primeiro
        let uploadSuccess = false;
        
        try {
            // Método 1: Tentar com fetch e mode: 'no-cors'
            const uploadResponse = await fetch(uploadData.url, {
                method: 'PUT',
                mode: 'cors',
                headers: {
                    'Content-Type': this.file.type,
                    'x-goog-content-length-range': uploadData.headers['x-goog-content-length-range'],
                    'x-goog-meta-user_id': uploadData.headers['x-goog-meta-user_id']
                },
                body: fileBuffer
            });
            
            uploadSuccess = uploadResponse.ok;
        } catch (fetchError) {
            console.log('Fetch failed, trying alternative method:', fetchError);
            
            // Método 2: Usar XMLHttpRequest
            try {
                await new Promise((resolve, reject) => {
                    const xhr = new XMLHttpRequest();
                    xhr.open('PUT', uploadData.url);
                    xhr.setRequestHeader('Content-Type', this.file.type);
                    xhr.setRequestHeader('x-goog-content-length-range', uploadData.headers['x-goog-content-length-range']);
                    xhr.setRequestHeader('x-goog-meta-user_id', uploadData.headers['x-goog-meta-user_id']);
                    
                    xhr.onload = () => {
                        if (xhr.status >= 200 && xhr.status < 300) {
                            uploadSuccess = true;
                            resolve();
                        } else {
                            reject(new Error(`XHR upload failed: ${xhr.status}`));
                        }
                    };
                    
                    xhr.onerror = () => reject(new Error('XHR network error'));
                    xhr.send(fileBuffer);
                });
            } catch (xhrError) {
                console.log('XHR failed, trying background script:', xhrError);
                
                // Método 3: Usar background script
                try {
                    const result = await new Promise((resolve, reject) => {
                        chrome.runtime.sendMessage({
                            action: 'uploadToStorage',
                            data: {
                                url: uploadData.url,
                                headers: {
                                    'Content-Type': this.file.type,
                                    'x-goog-content-length-range': uploadData.headers['x-goog-content-length-range'],
                                    'x-goog-meta-user_id': uploadData.headers['x-goog-meta-user_id']
                                },
                                body: Array.from(new Uint8Array(fileBuffer)),
                                fileId: this.id
                            }
                        }, (response) => {
                            if (chrome.runtime.lastError) {
                                reject(new Error(chrome.runtime.lastError.message));
                            } else if (response.success) {
                                uploadSuccess = true;
                                resolve(response);
                            } else {
                                reject(new Error(response.error));
                            }
                        });
                    });
                } catch (bgError) {
                    throw new Error(`Todos os métodos de upload falharam: ${bgError.message}`);
                }
            }
        }

        if (!uploadSuccess) {
            throw new Error('Falha no upload para Google Cloud Storage');
        }

        // Step 3: Generate download URL
        const downloadUrlResponse = await fetch(
            'https://api.lovable.dev/files/generate-download-url',
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${state.token}`,
                    'Cookie': state.cookieString,
                    'Origin': 'https://lovable.dev',
                    'Referer': 'https://lovable.dev/'
                },
                body: JSON.stringify({
                    dir_name: dir_name,
                    file_name: file_name
                })
            }
        );

        if (!downloadUrlResponse.ok) {
            const errorText = await downloadUrlResponse.text();
            console.error('Download URL error:', errorText);
            throw new Error(`Falha ao gerar URL de download: ${downloadUrlResponse.status}`);
        }

        const downloadData = await downloadUrlResponse.json();
        
        // Update file attachment
        this.url = downloadData.url;
        this.file_id = uploadData.file_id;
        this.uploading = false;
        
        updateFilePreviewStatus(this.id, 'complete');
        return true;
        
    } catch (error) {
        this.uploading = false;
        updateFilePreviewStatus(this.id, 'error');
        console.error('Upload error:', error);
        throw error;
    }
}
}

function updateFilePreviewStatus(fileId, status) {
    const previewItems = filePreview.querySelectorAll('.preview-item');
    previewItems.forEach(item => {
        const progressDiv = item.querySelector('.upload-progress');
        if (progressDiv && item.querySelector(`[onclick*="${fileId}"]`)) {
            switch(status) {
                case 'uploading':
                    progressDiv.textContent = '⏳ Upload...';
                    break;
                case 'complete':
                    progressDiv.textContent = '✅';
                    break;
                case 'error':
                    progressDiv.textContent = '❌';
                    break;
            }
        }
    });
}

// File selection handler
attachButton.addEventListener('click', () => {
    fileInput.click();
});

async function processFiles(files) {
    for (const file of files) {
        const attachment = new FileAttachment(file);
        await attachment.generatePreview();

        // Add to state
        state.files.push(attachment);

        // Show preview
        renderFilePreviews();

        // Start upload
        try {
            await attachment.upload(state);
            renderFilePreviews();
        } catch (error) {
            statusBar.textContent = `Erro no upload: ${error.message}`;
            statusBar.classList.add('error');
            setTimeout(() => {
                statusBar.classList.remove('error');
            }, 3000);
        }
    }
}

fileInput.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files);
    await processFiles(files);
    // Clear input
    fileInput.value = '';
});

// ===== Paste (Ctrl+V) support =====
// Captura imagens coladas em qualquer lugar do popup (inclusive no textarea)
document.addEventListener('paste', async (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    const files = [];
    for (const item of items) {
        if (item.kind === 'file') {
            const f = item.getAsFile();
            if (f) files.push(f);
        }
    }
    if (files.length > 0) {
        e.preventDefault();
        await processFiles(files);
    }
});

// ===== Drag & drop support =====
const dropZone = document.querySelector('.app-shell') || document.body;
['dragenter', 'dragover'].forEach((ev) => {
    dropZone.addEventListener(ev, (e) => {
        if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) {
            e.preventDefault();
            e.stopPropagation();
            dropZone.classList.add('drag-over');
        }
    });
});
['dragleave', 'dragend', 'drop'].forEach((ev) => {
    dropZone.addEventListener(ev, (e) => {
        if (ev === 'dragleave' && e.target !== dropZone) return;
        dropZone.classList.remove('drag-over');
    });
});
dropZone.addEventListener('drop', async (e) => {
    if (!e.dataTransfer) return;
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    await processFiles(files);
});



function renderFilePreviews() {
    if (state.files.length === 0) {
        filePreview.style.display = 'none';
        return;
    }
    
    filePreview.style.display = 'flex';
    filePreview.innerHTML = state.files.map(file => `
        <div class="preview-item">
            ${file.isImage 
                ? `<img src="${file.preview}" alt="${file.file_name}">`
                : `<div class="file-icon">📄</div>`
            }
            ${file.uploading 
                ? '<div class="upload-progress">⏳ Upload...</div>'
                : file.url 
                    ? '<div class="upload-progress">✅</div>'
                    : '<div class="upload-progress">⏳ Aguardando...</div>'
            }
            <div style="font-size: 10px; max-width: 60px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                ${file.file_name}
            </div>
            <button class="remove-file" data-file-id="${file.id}" type="button">×</button>
        </div>
    `).join('');
    filePreview.querySelectorAll('.remove-file').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            window.removeFile(btn.getAttribute('data-file-id'));
        });
    });
}

window.removeFile = function(fileId) {
    state.files = state.files.filter(f => f.id !== fileId);
    renderFilePreviews();
};

// Message handling
async function sendMessage() {
    const message = messageInput.value.trim();
    
    if (!message && state.files.length === 0) {
        return;
    }
    
    if (!state.projectId || !state.token) {
        statusBar.textContent = 'Erro: Projeto ou autenticação não configurados';
        statusBar.classList.add('error');
        return;
    }
    
    // Check if all files are uploaded
    const uploadingFiles = state.files.filter(f => f.uploading);
    if (uploadingFiles.length > 0) {
        statusBar.textContent = 'Aguarde o upload dos arquivos terminar...';
        statusBar.classList.add('error');
        setTimeout(() => {
            statusBar.classList.remove('error');
        }, 3000);
        return;
    }
    
    // Gate de licença obrigatório — bloqueia envio se a chave não estiver ativa/válida no servidor
    if (typeof window.__lvblAuthorizeSend !== 'function' || !(await window.__lvblAuthorizeSend())) {
        statusBar.textContent = 'Licença inválida. Reative sua chave para continuar.';
        statusBar.classList.add('error');
        setTimeout(() => statusBar.classList.remove('error'), 4000);
        return;
    }
    
    try {
        // Disable input
        messageInput.disabled = true;
        sendButton.disabled = true;
        statusBar.textContent = 'Enviando...';
        statusBar.classList.remove('error', 'success');
        
        // Create message body
        const ids = generateMessageId();
        
        let messageBody = {
            id: ids.userMessageId,
            message: message,
            files: [],
            selected_elements: [],
            chat_only: false,
            optimisticImageUrls: [],
            intent: "fix_error",
            message_intent_metadata: {
                fix_error_metadata: {
                    errors: [{
                        error_type: "build",
                        error_message: "",
                        build_event_id: "main:agent#00000000000123#bld:ZDP4ZE3D"
                    }]
                }
            },
            contains_error: true,
            error_ids: ["main:agent#00000000000123#bld:ZDP4ZE3D"],
            ai_message_id: ids.aiMessageId,
            thread_id: "main",
            current_page: "/",
            current_viewport_width: 1465,
            current_viewport_height: 408,
            current_viewport_dpr: 0.8999999761581421,
            view: "preview",
            view_description: "The user is currently viewing the preview.",
            model: null,
            network_requests: [],
            runtime_errors: [],
            integration_metadata: {
                browser: {
                    preview_viewport_width: 1465,
                    preview_viewport_height: 408,
                    is_logged_out: true
                }
            }
        };

        // ─── Modo Plano (PLAN) ───────────────────────────────────────────
        // Com o truque fix_error o backend ignora chat_only, então para o modo
        // plano funcionar de verdade limpamos os campos de erro e enviamos como
        // chat comum com chat_only=true (essa é a forma que a UI oficial usa).
        // Quando desligado, o payload original (fix_error) permanece intacto e
        // continua sem consumir créditos.
        let __planMode = false;
        try { __planMode = localStorage.getItem('lvbl_modo_plano') === '1'; } catch (_) {}
        if (__planMode) {
            messageBody.chat_only = true;
            messageBody.intent = undefined;
            messageBody.contains_error = false;
            messageBody.error_ids = [];
            messageBody.error_source = undefined;
            messageBody.message_intent_metadata = undefined;
        }


        
        // Add files if present
        if (state.files.length > 0) {
            messageBody.files = state.files.map(file => ({
                file_id: file.file_id,
                file_name: file.file_name,
                url: file.url
            }));
            
            messageBody.optimisticImageUrls = state.files
                .filter(file => file.url)
                .map(file => file.url);
        }
        
        // Add message to chat
        state.addMessage('user', message || '[Arquivos anexados]', 
            state.files.map(f => ({ 
                name: f.file_name, 
                url: f.url, 
                isImage: f.isImage,
                preview: f.preview
            })));
        
        renderMessages();
        
        // Send to API
        console.log('Sending message to API...');
        console.log('Project ID:', state.projectId);
        console.log('Token available:', !!state.token);
        
        // Segunda camada: só envia através do transporte fornecido pela licença.
        // Se license.js for removido/adulterado, __lvblFetch some e o envio quebra.
        const __lvblSend = window.__lvblFetch;
        if (typeof __lvblSend !== 'function') {
            statusBar.textContent = 'Licença inválida. Reative sua chave para continuar.';
            statusBar.classList.add('error');
            setTimeout(() => statusBar.classList.remove('error'), 4000);
            messageInput.disabled = false;
            sendButton.disabled = false;
            return;
        }
        const response = await __lvblSend(
            `https://api.lovable.dev/projects/${state.projectId}/chat`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${state.token}`,
                    'Origin': 'https://lovable.dev',
                    'Referer': 'https://lovable.dev/',
                    'Cookie': state.cookieString,
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36'
                },
                body: JSON.stringify(messageBody)
            }
        );
        
        console.log('Response status:', response.status);
        
        // Try to parse response
        let responseData;
        const responseText = await response.text();
        
        try {
            responseData = JSON.parse(responseText);
        } catch (e) {
            console.log('Response is not JSON:', responseText.substring(0, 200));
            responseData = { message: responseText };
        }
        
        if (!response.ok) {
            throw new Error(
                responseData.error?.message || 
                responseData.message || 
                `Erro ${response.status}: ${response.statusText}`
            );
        }
        
        // Add success message
        state.addMessage('agent', '✅ Mensagem enviada com sucesso');
        statusBar.textContent = 'Mensagem enviada com sucesso';
        statusBar.classList.add('success');
        
        // Clear input and files
        messageInput.value = '';
        state.files = [];
        renderFilePreviews();
        
        setTimeout(() => {
            statusBar.classList.remove('success');
            statusBar.textContent = 'Pronto para usar';
        }, 3000);
        
    } catch (error) {
        console.error('Send message error:', error);
        
        let errorMessage = error.message;
        
        // Handle specific error cases
        if (errorMessage.includes('403') || errorMessage.includes('Forbidden')) {
            errorMessage = 'Acesso negado. Verifique se você está logado no Lovable.dev e tente recarregar a página.';
        } else if (errorMessage.includes('401') || errorMessage.includes('Unauthorized')) {
            errorMessage = 'Sessão expirada. Faça login novamente no Lovable.dev.';
        } else if (errorMessage.includes('Failed to fetch') || errorMessage.includes('NetworkError')) {
            errorMessage = 'Erro de conexão. Verifique sua internet.';
        }
        
        state.addMessage('agent', `❌ Erro: ${errorMessage}`);
        statusBar.textContent = `Erro: ${errorMessage}`;
        statusBar.classList.add('error');
        
        setTimeout(() => {
            statusBar.classList.remove('error');
            statusBar.textContent = 'Pronto para usar';
        }, 5000);
        
    } finally {
        // Re-enable input
        messageInput.disabled = false;
        sendButton.disabled = false;
        messageInput.focus();
        renderMessages();
    }
}

function renderMessages() {
    messagesContainer.innerHTML = state.messages.map(msg => `
        <div class="message ${msg.type}">
            <div class="message-content">
                ${msg.content}
                ${msg.files && msg.files.length > 0 ? `
                    <div class="file-attachment">
                        ${msg.files.map(file => 
                            file.isImage && file.preview
                                ? `<img src="${file.preview}" alt="${file.name}" style="max-width: 200px; max-height: 200px;">`
                                : file.url
                                    ? `<div class="file-info">📎 <a href="${file.url}" target="_blank">${file.name}</a></div>`
                                    : `<div class="file-info">📎 ${file.name}</div>`
                        ).join('')}
                    </div>
                ` : ''}
            </div>
            <div class="message-time">
                ${new Date(msg.timestamp).toLocaleTimeString()}
            </div>
        </div>
    `).join('');
    
    // Scroll to bottom
    chatContainer.scrollTop = chatContainer.scrollHeight;
}

// Event listeners
sendButton.addEventListener('click', sendMessage);

messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

// Expose functions to global scope
window.removeFile = window.removeFile || function(fileId) {
    state.files = state.files.filter(f => f.id !== fileId);
    renderFilePreviews();
};

// Initialize on load
document.addEventListener('DOMContentLoaded', initialize);
// Drag panel from topbar (posts messages to parent content-panel.js)
(function () {
    function initDrag() {
        const bar = document.querySelector('.topbar');
        if (!bar || window.parent === window) return;
        bar.style.cursor = 'grab';
        bar.style.userSelect = 'none';
        let dragging = false, pid = null;
        bar.addEventListener('pointerdown', (e) => {
            if (e.target.closest('button')) return;
            dragging = true; pid = e.pointerId;
            bar.style.cursor = 'grabbing';
            try { bar.setPointerCapture(pid); } catch (_) {}
            window.parent.postMessage({ __lovableExt: 'dragStart', x: e.screenX, y: e.screenY }, '*');
            e.preventDefault();
        });
        bar.addEventListener('pointermove', (e) => {
            if (!dragging || e.pointerId !== pid) return;
            window.parent.postMessage({ __lovableExt: 'dragMove', x: e.screenX, y: e.screenY }, '*');
        });
        function end(e) {
            if (!dragging) return;
            dragging = false;
            bar.style.cursor = 'grab';
            try { bar.releasePointerCapture(pid); } catch (_) {}
            window.parent.postMessage({ __lovableExt: 'dragEnd' }, '*');
        }
        bar.addEventListener('pointerup', end);
        bar.addEventListener('pointercancel', end);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initDrag);
    else initDrag();
})();
