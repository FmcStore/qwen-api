document.addEventListener('DOMContentLoaded', () => {
  const chatForm = document.getElementById('chatForm');
  const messageInput = document.getElementById('messageInput');
  const chatHistory = document.getElementById('chatHistory');
  const sendBtn = document.getElementById('sendBtn');
  const emptyState = document.getElementById('emptyState');
  const previewFrame = document.getElementById('previewFrame');
  const sourceViewer = document.getElementById('sourceViewer');
  const sourceCode = document.getElementById('sourceCode');
  const toggleCodeBtn = document.getElementById('toggleCode');
  const refreshArtifactBtn = document.getElementById('refreshArtifact');

  let currentArtifactCode = '';
  let lastImageUrls = [];
  let conversationHistory = [
    { role: 'system', content: 'You are an expert web developer. When asked to build UI or apps, output complete, working HTML, CSS, and JS wrapped in standard markdown code blocks. Make it look beautiful and modern.' }
  ];
  let isViewingSource = false;

  // Configure DOMPurify to allow images
  const purifyConfig = {
    ADD_TAGS: ['img'],
    ADD_ATTR: ['src', 'alt', 'loading'],
  };

  // Auto-resize textarea
  messageInput.addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = (this.scrollHeight) + 'px';
    if (this.value.trim() === '') this.style.height = 'auto';
  });

  // Handle enter key to submit
  messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      chatForm.dispatchEvent(new Event('submit'));
    }
  });

  function addMessageToUI(role, content) {
    const msgDiv = document.createElement('div');
    msgDiv.className = `message ${role === 'user' ? 'user-msg' : 'system-msg'}`;
    
    const avatar = document.createElement('div');
    avatar.className = 'msg-avatar';
    avatar.textContent = role === 'user' ? '👤' : '🤖';
    
    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';
    
    // Parse markdown — allow img tags through DOMPurify
    const rawHtml = marked.parse(content || '');
    bubble.innerHTML = DOMPurify.sanitize(rawHtml, purifyConfig);
    
    msgDiv.appendChild(avatar);
    msgDiv.appendChild(bubble);
    chatHistory.appendChild(msgDiv);
    
    // Scroll to bottom
    chatHistory.scrollTop = chatHistory.scrollHeight;
    return bubble;
  }

  function extractAndRenderArtifact(markdownText) {
    // 1) Check for generated images first
    const imageRegex = /!\[.*?\]\((http:\/\/localhost:\d+\/generated\/[^\)]+)\)/g;
    const imageMatches = [...markdownText.matchAll(imageRegex)];
    
    if (imageMatches.length > 0) {
      const urls = imageMatches.map(m => m[1]);
      // Only update if we have new images
      if (JSON.stringify(urls) !== JSON.stringify(lastImageUrls)) {
        lastImageUrls = urls;
        emptyState.classList.add('hidden');
        previewFrame.classList.remove('hidden');
        
        // Build an HTML page that displays the images nicely
        const imageHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  body {
    margin: 0; padding: 20px;
    background: #0f1117;
    display: flex; flex-direction: column; align-items: center; gap: 16px;
    font-family: 'Inter', sans-serif;
    min-height: 100vh;
  }
  .img-container {
    background: #1a1d27;
    border-radius: 12px;
    padding: 12px;
    box-shadow: 0 4px 24px rgba(0,0,0,0.4);
    max-width: 100%;
  }
  img {
    max-width: 100%;
    height: auto;
    border-radius: 8px;
    display: block;
  }
  .label {
    color: #8b8fa3;
    font-size: 12px;
    margin-top: 8px;
    text-align: center;
    word-break: break-all;
  }
</style>
</head>
<body>
${urls.map((url, i) => `
  <div class="img-container">
    <img src="${url}" alt="Generated Image ${i + 1}" loading="lazy" />
    <div class="label">Image ${i + 1}</div>
  </div>
`).join('')}
</body>
</html>`;
        currentArtifactCode = imageHtml;
        renderToIframe();
        sourceCode.textContent = urls.join('\n');
      }
      return; // Don't check for code blocks if we have images
    }

    // 2) Look for HTML, CSS, or JS blocks
    const htmlMatch = markdownText.match(/```html\n([\s\S]*?)```/);
    const cssMatch = markdownText.match(/```css\n([\s\S]*?)```/);
    const jsMatch = markdownText.match(/```(?:js|javascript)\n([\s\S]*?)```/);

    let html = htmlMatch ? htmlMatch[1] : '';
    let css = cssMatch ? cssMatch[1] : '';
    let js = jsMatch ? jsMatch[1] : '';

    // If there is just one generic code block and it looks like HTML
    if (!html && !css && !js) {
      const genericMatch = markdownText.match(/```\n([\s\S]*?)```/);
      if (genericMatch && genericMatch[1].includes('<html') || genericMatch[1].includes('<div')) {
        html = genericMatch[1];
      }
    }

    if (html || css || js) {
      emptyState.classList.add('hidden');
      
      // Construct a single runnable HTML file
      let compiledCode = html;
      if (!compiledCode.includes('<!DOCTYPE html>')) {
        compiledCode = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>${css}</style>
</head>
<body>
${html}
<script>${js}<\/script>
</body>
</html>`;
      } else {
        // If it's a full HTML document, try to inject the CSS and JS
        if (css) compiledCode = compiledCode.replace('</head>', `<style>${css}</style></head>`);
        if (js) compiledCode = compiledCode.replace('</body>', `<script>${js}<\/script></body>`);
      }

      currentArtifactCode = compiledCode;
      
      // Update preview
      renderToIframe();
      
      // Update source viewer
      sourceCode.textContent = currentArtifactCode;
    }
  }

  function renderToIframe() {
    const iframeDoc = previewFrame.contentDocument || previewFrame.contentWindow.document;
    iframeDoc.open();
    iframeDoc.write(currentArtifactCode);
    iframeDoc.close();
  }

  refreshArtifactBtn.addEventListener('click', () => {
    if (currentArtifactCode) renderToIframe();
  });

  toggleCodeBtn.addEventListener('click', () => {
    isViewingSource = !isViewingSource;
    if (isViewingSource) {
      previewFrame.classList.add('hidden');
      sourceViewer.classList.remove('hidden');
      toggleCodeBtn.classList.add('active');
    } else {
      sourceViewer.classList.add('hidden');
      previewFrame.classList.remove('hidden');
      toggleCodeBtn.classList.remove('active');
    }
  });

  chatForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = messageInput.value.trim();
    if (!text) return;

    // Reset input
    messageInput.value = '';
    messageInput.style.height = 'auto';
    sendBtn.disabled = true;

    // Show user message
    addMessageToUI('user', text);
    conversationHistory.push({ role: 'user', content: text });

    // Setup empty assistant bubble
    const bubble = addMessageToUI('assistant', '...');
    let accumulatedResponse = '';

    try {
      const response = await fetch('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Conversation-Id': 'local-ui' },
        body: JSON.stringify({
          model: 'qwen3.8-max',
          messages: conversationHistory,
          stream: true,
          qwen_mode: 'web_dev'
        })
      });

      if (!response.ok) throw new Error('API Error: ' + response.statusText);

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n');
        
        for (const line of lines) {
          if (line.startsWith('data: ') && line !== 'data: [DONE]') {
            try {
              const data = JSON.parse(line.slice(6));
              const delta = data.choices[0].delta.content || '';
              accumulatedResponse += delta;
              
              // Render markdown — allow images
              bubble.innerHTML = DOMPurify.sanitize(marked.parse(accumulatedResponse), purifyConfig);
              chatHistory.scrollTop = chatHistory.scrollHeight;
              
              // Try extracting artifacts live
              extractAndRenderArtifact(accumulatedResponse);
            } catch (err) {
              // Ignore parse errors on incomplete chunks
            }
          }
        }
      }
      
      conversationHistory.push({ role: 'assistant', content: accumulatedResponse });
      
    } catch (err) {
      bubble.innerHTML = `<span style="color: #ef4444;">Error: ${err.message}</span>`;
    } finally {
      sendBtn.disabled = false;
      messageInput.focus();
    }
  });
});
