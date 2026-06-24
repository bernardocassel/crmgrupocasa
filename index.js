// ══════════════════════════════════════════════════════════
// CASA CRM BACKEND — WhatsApp via Baileys + QR Code
// ══════════════════════════════════════════════════════════
const express = require('express');
const cors    = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode  = require('qrcode');
const fs      = require('fs');
const path    = require('path');
const pino    = require('pino');

const app = express();
app.use(cors({
  origin: '*',
  methods: ['GET','POST','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization']
}));
app.options('*', cors());
app.use(express.json());

const PORT         = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Pasta de sessão (temporária, mas mantida enquanto servidor não reiniciar)
const SESSION_DIR = path.join('/tmp', 'wa-session');
if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });

// Estado global
let qrCodeBase64   = null;
let waConnected    = false;
let waSocket       = null;
let connectionStatus = 'desconectado';

// ══════════════════════════════════════════════════════════
// WHATSAPP CONNECTION
// ══════════════════════════════════════════════════════════
async function connectWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
  });

  waSocket = sock;

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('📱 QR Code gerado — acesse /qrcode para escanear');
      qrCodeBase64 = await qrcode.toDataURL(qr);
      connectionStatus = 'aguardando_qr';
      waConnected = false;
    }

    if (connection === 'close') {
      waConnected = false;
      connectionStatus = 'desconectado';
      const shouldReconnect = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut
        : true;
      console.log('🔴 Conexão encerrada. Reconectando:', shouldReconnect);
      if (shouldReconnect) {
        setTimeout(connectWhatsApp, 3000);
      } else {
        // Logged out — limpa sessão
        fs.rmSync(SESSION_DIR, { recursive: true, force: true });
        fs.mkdirSync(SESSION_DIR, { recursive: true });
        setTimeout(connectWhatsApp, 3000);
      }
    }

    if (connection === 'open') {
      waConnected = true;
      connectionStatus = 'conectado';
      qrCodeBase64 = null;
      console.log('✅ WhatsApp conectado!');
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (msg.key.fromMe) continue; // ignora mensagens enviadas por você
      if (msg.key.remoteJid?.includes('@g.us')) continue; // ignora grupos

      const phone = msg.key.remoteJid?.replace('@s.whatsapp.net', '') || '';
      const text  = msg.message?.conversation
                 || msg.message?.extendedTextMessage?.text
                 || msg.message?.imageMessage?.caption
                 || '';
      const name  = msg.pushName || phone;

      if (!phone) continue;
      console.log(`📩 Mensagem de ${name} (${phone}): ${text.slice(0, 60)}`);
      await processarLead({ phone, name, text });
    }
  });
}

// ══════════════════════════════════════════════════════════
// PROCESSAR LEAD
// ══════════════════════════════════════════════════════════
async function processarLead({ phone, name, text }) {
  try {
    const { data: existing } = await supabase
      .from('leads')
      .select('*')
      .eq('phone_raw', phone)
      .eq('deleted', false)
      .limit(1);

    if (existing && existing.length > 0) {
      const lead = existing[0];
      const history = lead.history || [];
      history.push({ date: nowStr(), text: `📱 WhatsApp: "${text.slice(0, 200)}"` });
      await supabase.from('leads').update({ history, updated_at: new Date().toISOString() }).eq('id', lead.id);
      console.log(`♻️  Lead atualizado: ${lead.name}`);
      return;
    }

    const novoLead = {
      id:         uid(),
      name,
      phone:      formatarTelefone(phone),
      phone_raw:  phone,
      interest:   detectarInteresse(text),
      emp:        'Indefinido',
      stage:      'novo',
      raw_value:  0,
      history:    [{ date: nowStr(), text: `📱 Primeiro contato via WhatsApp: "${text.slice(0, 200)}"` }],
      deleted:    false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      source:     'WhatsApp'
    };

    const { error } = await supabase.from('leads').insert([novoLead]);
    if (error) console.error('Erro ao criar lead:', error.message);
    else console.log(`✅ Novo lead: ${name} — Interesse: ${novoLead.interest}`);
  } catch (err) {
    console.error('Erro processarLead:', err.message);
  }
}

// ══════════════════════════════════════════════════════════
// ROTAS
// ══════════════════════════════════════════════════════════

// Health check (UptimeRobot faz ping aqui)
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Casa CRM Backend', wa: connectionStatus, ts: new Date().toISOString() });
});

// QR Code para conectar WhatsApp
app.get('/qrcode', (req, res) => {
  if (waConnected) {
    return res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#f5f0e8">
        <h2 style="color:#1a1a18">✅ WhatsApp conectado!</h2>
        <p style="color:#888">O WhatsApp Business está ativo e recebendo leads.</p>
        <p style="color:#888;font-size:13px">Status: <b>online</b></p>
      </body></html>
    `);
  }
  if (qrCodeBase64) {
    return res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#f5f0e8">
        <h2 style="color:#1a1a18">📱 Escanear QR Code</h2>
        <p style="color:#555">Abra o WhatsApp Business → Menu → Aparelhos conectados → Conectar aparelho</p>
        <img src="${qrCodeBase64}" style="width:280px;height:280px;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,0.1)">
        <p style="color:#888;font-size:13px;margin-top:16px">A página atualiza automaticamente...</p>
        <script>setTimeout(()=>location.reload(), 8000)</script>
      </body></html>
    `);
  }
  res.send(`
    <html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#f5f0e8">
      <h2>⏳ Iniciando conexão...</h2>
      <p>Aguarde alguns segundos e recarregue a página.</p>
      <script>setTimeout(()=>location.reload(), 4000)</script>
    </body></html>
  `);
});

// Status da conexão
app.get('/status', (req, res) => {
  res.json({ connected: waConnected, status: connectionStatus });
});

// Desconectar e gerar novo QR
app.post('/reconectar', async (req, res) => {
  fs.rmSync(SESSION_DIR, { recursive: true, force: true });
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  if (waSocket) { try { await waSocket.logout(); } catch(e) {} }
  setTimeout(connectWhatsApp, 1000);
  res.json({ ok: true, msg: 'Reconectando...' });
});

// ── LEADS ────────────────────────────────────────────────
app.get('/leads', async (req, res) => {
  const emp = req.query.emp;
  let query = supabase.from('leads').select('*').eq('deleted', false).order('created_at', { ascending: false });
  if (emp && emp !== 'all') query = query.eq('emp', emp);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/leads', async (req, res) => {
  const lead = { ...req.body, id: uid(), deleted: false, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  const { data, error } = await supabase.from('leads').insert([lead]).select();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data[0]);
});

app.patch('/leads/:id', async (req, res) => {
  const { data, error } = await supabase.from('leads').update({ ...req.body, updated_at: new Date().toISOString() }).eq('id', req.params.id).select();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data[0]);
});

app.delete('/leads/:id', async (req, res) => {
  const { error } = await supabase.from('leads').update({ deleted: true }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── TASKS ────────────────────────────────────────────────
app.get('/tasks', async (req, res) => {
  const { data, error } = await supabase.from('tasks').select('*').order('date', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/tasks', async (req, res) => {
  const task = { ...req.body, id: uid(), created_at: new Date().toISOString() };
  const { data, error } = await supabase.from('tasks').insert([task]).select();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data[0]);
});

app.patch('/tasks/:id', async (req, res) => {
  const { data, error } = await supabase.from('tasks').update(req.body).eq('id', req.params.id).select();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data[0]);
});

app.delete('/tasks/:id', async (req, res) => {
  const { error } = await supabase.from('tasks').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════
function uid() { return Date.now() + '-' + Math.random().toString(36).slice(2, 8); }
function nowStr() { return new Date().toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' }); }
function formatarTelefone(raw) {
  const d = raw.replace(/\D/g, '').replace(/^55/, '');
  if (d.length === 11) return `(${d.slice(0,2)}) ${d.slice(2,7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0,2)}) ${d.slice(2,6)}-${d.slice(6)}`;
  return raw;
}
function detectarInteresse(text) {
  const t = (text || '').toLowerCase();
  if (t.includes('venezza')) return 'Venezza';
  if (t.includes('milano'))  return 'Milano';
  return 'Outro';
}






// ══════════════════════════════════════════════════════════
// IMPORTAR CONVERSAS DOS ÚLTIMOS 30 DIAS DO WHATSAPP
// ══════════════════════════════════════════════════════════
app.post('/importar-whatsapp', async (req, res) => {
  if (!waSocket || !waConnected) {
    return res.status(400).json({ error: 'WhatsApp não conectado. Acesse /qrcode primeiro.' });
  }
  try {
    console.log('📥 Iniciando importação de conversas...');
    const limite30dias = Date.now() - (30 * 24 * 60 * 60 * 1000);
    let importados = 0, ignorados = 0, erros = 0;

    // Acessa chats do store interno do Baileys
    const chatMap = waSocket.store?.chats || waSocket.chats || {};
    const chatList = typeof chatMap.all === 'function' ? chatMap.all() : Object.values(chatMap);

    for(const chat of chatList){
      const jid = chat.id || chat.jid || '';
      if(!jid || jid.includes('@g.us') || jid.includes('@broadcast') || jid.includes('@newsletter')) continue;

      const ts = (chat.conversationTimestamp || chat.t || 0) * 1000;
      if(ts > 0 && ts < limite30dias) continue;

      const phone = jid.replace('@s.whatsapp.net','').replace('@c.us','');
      if(!phone || phone.length < 8) continue;
      const name = chat.name || chat.pushName || chat.notify || phone;

      try {
        const { data: existing } = await supabase.from('leads').select('id').eq('phone_raw', phone).limit(1);
        if(existing && existing.length > 0){ ignorados++; continue; }
        await supabase.from('leads').insert([{
          id: uid(), name, phone: formatarTelefone(phone), phone_raw: phone,
          interest: '', emp: 'Indefinido', stage: 'novo', raw_value: 0,
          history: [{ date: nowStr(), text: '📥 Importado do histórico do WhatsApp' }],
          deleted: false, source: 'WhatsApp (importado)',
          created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        }]);
        importados++;
      } catch(e){ erros++; console.error('Erro ao importar', phone, e.message); }
    }

    console.log(`✅ Importação: ${importados} novos, ${ignorados} já existiam, ${erros} erros`);
    res.json({ ok: true, importados, ignorados, erros });
  } catch(err) {
    console.error('Erro na importação:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── SERVE CRM ────────────────────────────────────────────
app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'crm.html'));
});

// ══════════════════════════════════════════════════════════
// START
// ══════════════════════════════════════════════════════════
app.listen(PORT, async () => {
  console.log(`🚀 Casa CRM Backend rodando na porta ${PORT}`);
  console.log(`📱 QR Code disponível em: /qrcode`);
  await connectWhatsApp();
});
