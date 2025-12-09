/**
 * =================================================================================
 * 项目: minitoolai-2api (Cloudflare Worker 单文件版)
 * 版本: 3.0.0 (代号: JS-Miner - 脚本挖掘版)
 * 作者: 首席AI执行官 (Principal AI Executive Officer)
 * 协议: 奇美拉协议 · 综合版 (Project Chimera: Synthesis Edition)
 * 日期: 2025-12-09
 * 
 * [v3.0.0 关键修复与升级]
 * 1. [精准挖掘] 修正了 Token 提取逻辑，从 JS 变量而非 HTML 标签中提取凭证。
 * 2. [Cookie同步] 实现了 CookieJar 机制，自动合并主页响应的新 Cookie。
 * 3. [智能回退] 动态获取失败时（如遇 CF 盾），无缝切换至静态保底凭证。
 * 4. [全功能] 包含 Web UI、API 代理、流式转换、错误处理。
 * =================================================================================
 */

// --- [第一部分: 核心配置 (Configuration-as-Code)] ---
const CONFIG = {
  PROJECT_NAME: "minitoolai-2api",
  PROJECT_VERSION: "3.0.0",
  
  // 安全配置 (建议在 Cloudflare 环境变量中设置 API_MASTER_KEY)
  API_MASTER_KEY: "1", 
  
  // 上游服务配置
  UPSTREAM_ORIGIN: "https://minitoolai.com",
  UPSTREAM_HOME: "https://minitoolai.com/chatGPT/",
  UPSTREAM_API: "https://minitoolai.com/chatGPT/chatgpt_stream.php",
  
  // [保底凭证]：当动态获取失败（如遇 CF 盾）时使用的备用凭证
  // 这些值来自你提供的抓包数据，作为最后的防线
  FALLBACK_SECRETS: {
    UTOKEN: "8f8d3143125664b71458d3661649e69860074c1fbfe363681730e7ecccc225d9",
    SAFETY_ID: "80abe09afdf14a4ee70118616d75ac32f9cac69b0b8a39a7ed44a179b0351822",
    COOKIE: "PHPSESSID=de86e24808dd8fdfbb8dfdb554b06d4d; FCCDCF=%5Bnull%2Cnull%2Cnull%2Cnull%2Cnull%2Cnull%2C%5B%5B32%2C%22%5B%5C%22cc9ede00-2ee3-4725-b23b-e9ac0a80d9f4%5C%22%2C%5B1765278488%2C836000000%5D%5D%22%5D%5D%5D; FCNEC=%5B%5B%22AKsRol_ihgLJ53nSi8xYRhJedbXt35FPYz4dkJLkx9wpYVTqOhiu-YHIZxs_8cumDl2mdL734dcignAekcZpbYlveXnr6nke6rZhuB8j1SCp-iX7xMTyuLlKipu6jUoWr2dp85vhxUx6ihwiuwil1dzr8wJyvBgv8A%3D%3D%22%5D%5D; _gcl_au=1.1.808072355.1765278498; _ga=GA1.1.1803793263.1765278492; _ga_TDY3XB0LQQ=GS2.1.s1765278487$o1$g0$t1765278498$j60$l0$h9296027"
  },

  // 伪装指纹 (模拟真实浏览器)
  HEADERS: {
    "authority": "minitoolai.com",
    "accept": "*/*",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
    "origin": "https://minitoolai.com",
    "referer": "https://minitoolai.com/chatGPT/",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
    "sec-ch-ua": '"Chromium";v="142", "Google Chrome";v="142", "Not_A Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin"
  },

  // 模型列表
  MODELS: [
    "gpt-5-mini",
    "gpt-4o",
    "gpt-4o-mini"
  ],
  DEFAULT_MODEL: "gpt-5-mini"
};

// --- [第二部分: 辅助类与工具] ---

// 日志记录器
class Logger {
    constructor() { this.logs = []; }
    add(step, data) {
        const time = new Date().toISOString().split('T')[1].slice(0, -1);
        let content = "";
        try {
            content = typeof data === 'object' ? JSON.stringify(data) : String(data);
        } catch (e) { content = String(data); }
        this.logs.push({ time, step, content });
    }
    get() { return this.logs; }
}

// Cookie 管理器 (用于合并新旧 Cookie)
class CookieJar {
    constructor(initialCookie = "") {
        this.cookies = new Map();
        this.parse(initialCookie);
    }

    parse(cookieStr) {
        if (!cookieStr) return;
        cookieStr.split(';').forEach(pair => {
            const parts = pair.trim().split('=');
            if (parts.length >= 2) {
                const key = parts[0];
                const value = parts.slice(1).join('=');
                this.cookies.set(key, value);
            }
        });
    }

    // 从 fetch 的 Response Headers 中合并 Set-Cookie
    mergeFromResponse(headers) {
        const setCookie = headers.get('set-cookie');
        if (setCookie) {
            // 处理多个 Set-Cookie 头 (Cloudflare Worker 有时会合并它们)
            // 简单的分割逻辑，主要针对 PHPSESSID 等关键 Cookie
            const parts = setCookie.split(/,(?=\s*[^;]+=[^;]+)/); 
            parts.forEach(part => {
                const cookiePart = part.split(';')[0].trim();
                const [key, ...values] = cookiePart.split('=');
                if (key) this.cookies.set(key, values.join('='));
            });
        }
    }

    toString() {
        let str = "";
        for (const [key, value] of this.cookies) {
            str += `${key}=${value}; `;
        }
        return str.trim();
    }
}

// --- [第三部分: Worker 入口与路由] ---
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // 环境变量覆盖
    const apiKey = env.API_MASTER_KEY || CONFIG.API_MASTER_KEY;
    
    request.ctx = { apiKey };

    // 1. CORS 预检
    if (request.method === 'OPTIONS') return handleCorsPreflight();

    // 2. 路由分发
    if (url.pathname === '/') return handleUI(request);
    if (url.pathname.startsWith('/v1/')) return handleApi(request);
    
    return createErrorResponse(`路径未找到: ${url.pathname}`, 404, 'not_found');
  }
};

// --- [第四部分: 核心业务逻辑] ---

async function handleApi(request) {
  if (!verifyAuth(request)) return createErrorResponse('Unauthorized', 401, 'unauthorized');

  const url = new URL(request.url);
  const requestId = `req-${crypto.randomUUID()}`;

  if (url.pathname === '/v1/models') {
    return new Response(JSON.stringify({
      object: 'list',
      data: CONFIG.MODELS.map(id => ({ id, object: 'model', created: Date.now(), owned_by: 'minitoolai' }))
    }), { headers: corsHeaders({ 'Content-Type': 'application/json' }) });
  }

  if (url.pathname === '/v1/chat/completions') {
    return handleChatCompletions(request, requestId);
  }

  return createErrorResponse('Not Found', 404, 'not_found');
}

// 核心：动态收割凭证 (JS 变量提取版)
async function harvestCredentials(logger) {
    logger.add("Harvest", "正在访问主页以获取最新凭证...");
    
    try {
        const res = await fetch(CONFIG.UPSTREAM_HOME, {
            method: "GET",
            headers: {
                ...CONFIG.HEADERS,
                "cache-control": "no-cache",
                "pragma": "no-cache"
            }
        });

        // 检查是否被 CF 拦截
        if (res.status === 403 || res.status === 503) {
            const text = await res.text();
            if (text.includes("Just a moment") || text.includes("Cloudflare")) {
                logger.add("Harvest", "⚠️ 遭遇 Cloudflare 盾，无法动态获取，将回退到保底凭证。");
                return null; 
            }
        }

        if (!res.ok) {
            logger.add("Harvest", `主页访问失败: ${res.status}`);
            return null;
        }

        // 1. 提取并合并 Cookie
        // 我们基于保底 Cookie 进行更新，这样即使新 Cookie 不全，旧的也能用
        const cookieJar = new CookieJar(CONFIG.FALLBACK_SECRETS.COOKIE); 
        cookieJar.mergeFromResponse(res.headers);
        
        // 2. 提取 HTML 中的 JS 变量
        const html = await res.text();
        
        // 针对 minitoolai 源码的特定正则
        // var utoken = "xxx";
        const utokenMatch = html.match(/var\s+utoken\s*=\s*["']([^"']+)["']/);
        // var safety_identifier = "xxx";
        const safetyMatch = html.match(/var\s+safety_identifier\s*=\s*["']([^"']+)["']/);

        const utoken = utokenMatch ? utokenMatch[1] : null;
        const safetyId = safetyMatch ? safetyMatch[1] : null;

        if (utoken && safetyId) {
            logger.add("Harvest", `✅ 成功提取动态凭证! utoken=${utoken.substring(0,6)}...`);
            return {
                UTOKEN: utoken,
                SAFETY_ID: safetyId,
                COOKIE: cookieJar.toString()
            };
        } else {
            logger.add("Harvest", "⚠️ 未能在 JS 中找到变量，可能页面结构变更。");
            // 调试用：记录一小段 HTML 看看
            // logger.add("DebugHTML", html.substring(0, 500)); 
            return null;
        }

    } catch (e) {
        logger.add("Harvest", `收割过程异常: ${e.message}`);
        return null;
    }
}

async function handleChatCompletions(request, requestId) {
  const logger = new Logger();
  try {
    const body = await request.json();
    const messages = body.messages || [];
    const lastMsg = messages[messages.length - 1];
    const prompt = lastMsg?.content || "Hello";
    const model = body.model || CONFIG.DEFAULT_MODEL;
    const isWebUI = body.is_web_ui === true;

    // --- 步骤 1: 获取凭证 (动态优先，静态保底) ---
    let secrets = await harvestCredentials(logger);
    
    if (!secrets) {
        logger.add("Auth", "使用保底静态凭证 (Fallback Mode)");
        secrets = CONFIG.FALLBACK_SECRETS;
    } else {
        logger.add("Auth", "使用动态获取的凭证 (Fresh Mode)");
    }

    // --- 步骤 2: 构造请求参数 ---
    const params = new URLSearchParams();
    // 填充空参数以模拟真实请求
    params.append("messagebase64img1", "");
    params.append("messagebase64img0", "");
    params.append("safety_identifier", secrets.SAFETY_ID);
    params.append("select_model", model);
    params.append("temperature", "0.7");
    params.append("utoken", secrets.UTOKEN);
    params.append("message", prompt);
    // 模拟空的历史记录参数
    ["umes1a", "umes1stimg1a", "umes2ndimg1a", "bres1a", "umes2a", "umes1stimg2a", "umes2ndimg2a", "bres2a"].forEach(k => params.append(k, ""));

    // --- 步骤 3: POST 握手 (提交任务) ---
    logger.add("Step 1", "POST 提交任务...");
    const postRes = await fetch(CONFIG.UPSTREAM_API, {
      method: "POST",
      headers: {
        ...CONFIG.HEADERS,
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "cookie": secrets.COOKIE,
        "x-requested-with": "XMLHttpRequest"
      },
      body: params.toString()
    });

    if (!postRes.ok) {
      const errText = await postRes.text();
      throw new Error(`POST 握手失败 (${postRes.status}): ${errText.substring(0, 100)}`);
    }

    // --- 步骤 4: GET 监听 (建立流) ---
    logger.add("Step 2", "GET 建立 SSE 连接...");
    const getRes = await fetch(CONFIG.UPSTREAM_API, {
      method: "GET",
      headers: {
        ...CONFIG.HEADERS,
        "accept": "text/event-stream",
        "cache-control": "no-cache",
        "cookie": secrets.COOKIE // 必须使用相同的 Cookie
      }
    });

    if (!getRes.ok) {
      throw new Error(`GET 流连接失败: ${getRes.status}`);
    }

    // --- 步骤 5: 流式转换 ---
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    (async () => {
      try {
        // WebUI 调试日志注入
        if (isWebUI) {
          await writer.write(encoder.encode(`data: ${JSON.stringify({ debug: logger.get() })}\n\n`));
        }

        const reader = getRes.body.getReader();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const dataStr = line.slice(6).trim();
              if (!dataStr) continue;

              try {
                const data = JSON.parse(dataStr);
                
                // 转换逻辑
                if (data.type === 'response.output_text.delta' && data.delta) {
                  const chunk = {
                    id: requestId,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: model,
                    choices: [{ index: 0, delta: { content: data.delta }, finish_reason: null }]
                  };
                  await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                }
                else if (data.type === 'response.completed') {
                  // 完成
                }
              } catch (e) { }
            }
          }
        }
        
        // 结束块
        const endChunk = {
            id: requestId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
        };
        await writer.write(encoder.encode(`data: ${JSON.stringify(endChunk)}\n\n`));
        await writer.write(encoder.encode('data: [DONE]\n\n'));

      } catch (e) {
        const errChunk = {
            id: requestId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: model,
            choices: [{ index: 0, delta: { content: `\n\n[流传输中断: ${e.message}]` }, finish_reason: "error" }]
        };
        await writer.write(encoder.encode(`data: ${JSON.stringify(errChunk)}\n\n`));
      } finally {
        await writer.close();
      }
    })();

    return new Response(readable, {
      headers: corsHeaders({ 'Content-Type': 'text/event-stream' })
    });

  } catch (e) {
    return createErrorResponse(e.message, 500, 'internal_error');
  }
}

// --- 辅助函数 ---

function verifyAuth(request) {
  const auth = request.headers.get('Authorization');
  const key = request.ctx.apiKey;
  if (key === "1") return true;
  return auth === `Bearer ${key}`;
}

function createErrorResponse(msg, status, code) {
  return new Response(JSON.stringify({ error: { message: msg, type: 'api_error', code } }), {
    status, headers: corsHeaders({ 'Content-Type': 'application/json' })
  });
}

function corsHeaders(headers = {}) {
  return {
    ...headers,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

function handleCorsPreflight() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

// --- [第五部分: 开发者驾驶舱 UI (WebUI)] ---
function handleUI(request) {
  const origin = new URL(request.url).origin;
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${CONFIG.PROJECT_NAME} - 开发者驾驶舱</title>
    <style>
      :root { --bg: #121212; --panel: #1E1E1E; --border: #333; --text: #E0E0E0; --primary: #FFBF00; --accent: #007AFF; }
      body { font-family: 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); margin: 0; height: 100vh; display: flex; overflow: hidden; }
      .sidebar { width: 380px; background: var(--panel); border-right: 1px solid var(--border); padding: 20px; display: flex; flex-direction: column; overflow-y: auto; }
      .main { flex: 1; display: flex; flex-direction: column; padding: 20px; }
      
      .box { background: #252525; padding: 12px; border-radius: 6px; border: 1px solid var(--border); margin-bottom: 15px; }
      .label { font-size: 12px; color: #888; margin-bottom: 5px; display: block; }
      .code-block { font-family: monospace; font-size: 12px; color: var(--primary); word-break: break-all; background: #111; padding: 8px; border-radius: 4px; cursor: pointer; }
      
      input, select, textarea { width: 100%; background: #333; border: 1px solid #444; color: #fff; padding: 8px; border-radius: 4px; margin-bottom: 10px; box-sizing: border-box; }
      button { width: 100%; padding: 10px; background: var(--primary); border: none; border-radius: 4px; font-weight: bold; cursor: pointer; color: #000; }
      button:disabled { background: #555; cursor: not-allowed; }
      
      .chat-window { flex: 1; background: #000; border: 1px solid var(--border); border-radius: 8px; padding: 20px; overflow-y: auto; display: flex; flex-direction: column; gap: 15px; }
      .msg { max-width: 80%; padding: 10px 15px; border-radius: 8px; line-height: 1.5; }
      .msg.user { align-self: flex-end; background: #333; color: #fff; }
      .msg.ai { align-self: flex-start; background: #1a1a1a; border: 1px solid #333; width: 100%; max-width: 100%; }
      
      .log-panel { height: 180px; background: #111; border-top: 1px solid var(--border); padding: 10px; font-family: monospace; font-size: 11px; color: #aaa; overflow-y: auto; }
      .log-entry { margin-bottom: 4px; border-bottom: 1px solid #222; padding-bottom: 2px; }
      .log-time { color: #666; margin-right: 5px; }
      .log-step { color: var(--primary); font-weight: bold; margin-right: 5px; }
    </style>
</head>
<body>
    <div class="sidebar">
        <h2 style="margin-top:0">🤖 ${CONFIG.PROJECT_NAME} <span style="font-size:12px;color:#888">v${CONFIG.PROJECT_VERSION}</span></h2>
        
        <div class="box">
            <span class="label">API 密钥 (点击复制)</span>
            <div class="code-block" onclick="copy('${request.ctx.apiKey}')">${request.ctx.apiKey}</div>
        </div>

        <div class="box">
            <span class="label">API 接口地址</span>
            <div class="code-block" onclick="copy('${origin}/v1/chat/completions')">${origin}/v1/chat/completions</div>
        </div>

        <div class="box">
            <span class="label">模型</span>
            <select id="model">
                ${CONFIG.MODELS.map(m => `<option value="${m}">${m}</option>`).join('')}
            </select>
            
            <span class="label">提示词 (Prompt)</span>
            <textarea id="prompt" rows="4" placeholder="输入你的问题...">你好，请介绍一下你自己。</textarea>
            
            <button id="btn-gen" onclick="send()">发送请求</button>
        </div>
        
        <div class="box" style="font-size:12px;color:#888">
            <p>ℹ️ <strong>机制说明：</strong></p>
            <p>系统会优先尝试动态获取最新凭证。如果遇到 Cloudflare 盾，将自动回退到内置的保底凭证。</p>
        </div>
    </div>

    <main class="main">
        <div class="chat-window" id="chat">
            <div style="color:#666; text-align:center; margin-top:50px;">
                MinitoolAI 代理服务就绪。<br>
                支持双步流式协议 (POST+GET) 与自动凭证续期。
            </div>
        </div>
        <div class="log-panel" id="logs">
            <div class="log-entry">系统初始化完成。等待请求...</div>
        </div>
    </main>

    <script>
        const API_KEY = "${request.ctx.apiKey}";
        const ENDPOINT = "${origin}/v1/chat/completions";

        function log(step, msg) {
            const el = document.getElementById('logs');
            const div = document.createElement('div');
            div.className = 'log-entry';
            div.innerHTML = \`<span class="log-time">[\${new Date().toLocaleTimeString()}]</span><span class="log-step">\${step}:</span> \${msg}\`;
            el.appendChild(div);
            el.scrollTop = el.scrollHeight;
        }

        function copy(text) {
            navigator.clipboard.writeText(text);
            log('System', '已复制到剪贴板');
        }

        function appendMsg(role, text) {
            const div = document.createElement('div');
            div.className = \`msg \${role}\`;
            div.innerText = text;
            document.getElementById('chat').appendChild(div);
            div.scrollIntoView({ behavior: "smooth" });
            return div;
        }

        async function send() {
            const prompt = document.getElementById('prompt').value.trim();
            if (!prompt) return alert('请输入提示词');

            const btn = document.getElementById('btn-gen');
            btn.disabled = true;
            btn.innerText = "请求中...";

            if(document.querySelector('.chat-window').innerText.includes('代理服务就绪')) {
                document.getElementById('chat').innerHTML = '';
            }

            appendMsg('user', prompt);
            const aiMsg = appendMsg('ai', '...');
            let fullText = '';

            try {
                log('Client', '开始发送请求...');
                const res = await fetch(ENDPOINT, {
                    method: 'POST',
                    headers: { 
                        'Authorization': 'Bearer ' + API_KEY, 
                        'Content-Type': 'application/json' 
                    },
                    body: JSON.stringify({
                        model: document.getElementById('model').value,
                        messages: [{ role: 'user', content: prompt }],
                        stream: true,
                        is_web_ui: true
                    })
                });

                if (!res.ok) throw new Error((await res.json()).error?.message || '请求失败');

                const reader = res.body.getReader();
                const decoder = new TextDecoder();
                aiMsg.innerText = '';

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    const chunk = decoder.decode(value);
                    const lines = chunk.split('\\n');
                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            const dataStr = line.slice(6);
                            if (dataStr === '[DONE]') break;
                            try {
                                const json = JSON.parse(dataStr);
                                if (json.debug) {
                                    json.debug.forEach(d => log(d.step, d.content || d.data));
                                    continue;
                                }
                                const content = json.choices[0].delta.content;
                                if (content) {
                                    fullText += content;
                                    aiMsg.innerText = fullText;
                                }
                            } catch (e) {}
                        }
                    }
                }
                log('Client', '响应接收完成');

            } catch (e) {
                aiMsg.innerText = 'Error: ' + e.message;
                aiMsg.style.color = '#CF6679';
                log('Error', e.message);
            } finally {
                btn.disabled = false;
                btn.innerText = "发送请求";
            }
        }
    </script>
</body>
</html>`;

  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
