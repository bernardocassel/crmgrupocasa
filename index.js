// ══════════════════════════════════════════════════════════
// CASA CRM BACKEND — Evolution API (WhatsApp QR Code)
// ══════════════════════════════════════════════════════════
const express = require('express');
const cors    = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

const PORT         = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── HEALTH ───────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Casa CRM Backend', ts: new Date().toISOString() });
});

// ══════════════════════════════════════════════════════════
// WEBHOOK — Evolution API
// Recebe eventos do WhatsApp e cria leads
// ══════════════════════════════════════════════════════════
app.post('/webhook/evolution', async (req, res) => {
  res.status(200).send('OK');

  try {
    const body = req.body;

    // Só processa mensagens recebidas (não enviadas por você)
    if (body.event !== 'messages.upsert') return;
    const msg = body.data;
    if (!msg || msg.key?.fromMe) return; // ignora mensagens enviadas por você
    if (msg.messageType !== 'conversation' && msg.messageType !== 'extendedTextMessage') return;

    const phone   = msg.key.remoteJid?.replace('@s.whatsapp.net', '') || '';
    const text    = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
    const name    = msg.pushName || phone;

    if (!phone || phone.includes('@g.us')) return; // ignora grupos

    console.log(`📩 Mensagem de ${name} (${phone}): ${text.slice(0, 60)}`);
    await processarLead({ phone, name, text });

  } catch (err) {
    console.error('Erro no webhook:', err.message);
  }
});

// ══════════════════════════════════════════════════════════
// LÓGICA: criar ou atualizar lead
// ══════════════════════════════════════════════════════════
async function processarLead({ phone, name, text }) {
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
    console.log(`♻️  Lead existente atualizado: ${lead.name}`);
    return;
  }

  const novoLead = {
    id:         uid(),
    name:       name,
    phone:      formatarTelefone(phone),
    phone_raw:  phone,
    interest:   detectarInteresse(text),
    emp:        'Maré Empreendimentos',
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
  else console.log(`✅ Novo lead criado: ${name} (${phone}) — Interesse: ${novoLead.interest}`);
}

// ══════════════════════════════════════════════════════════
// APIS REST
// ══════════════════════════════════════════════════════════
app.get('/leads', async (req, res) => {
  const emp = req.query.emp;
  let query = supabase.from('leads').select('*').eq('deleted', false).order('created_at', { ascending: false });
  if (emp && emp !== 'all') query = query.eq('emp', emp);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/leads', async (req, res) => {
  const lead = { ...req.body, id: uid(), deleted: false, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), source: req.body.source || 'Manual' };
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

app.get('/stats', async (req, res) => {
  const emp = req.query.emp;
  let q = supabase.from('leads').select('stage, raw_value').eq('deleted', false);
  if (emp && emp !== 'all') q = q.eq('emp', emp);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  const by = s => data.filter(l => l.stage === s).length;
  res.json({ total: data.length, novo: by('novo'), contato: by('contato'), visita: by('visita'), proposta: by('proposta'), negociacao: by('negociacao'), fechado: by('fechado'), perdido: by('perdido'), vgv: data.reduce((s, l) => s + (l.raw_value || 0), 0) });
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
  const t = text.toLowerCase();
  if (t.includes('venezza')) return 'Venezza';
  if (t.includes('milano'))  return 'Milano';
  return 'Outro';
}

app.listen(PORT, () => {
  console.log(`🚀 Casa CRM Backend rodando na porta ${PORT}`);
  console.log(`📡 Webhook Evolution API: POST /webhook/evolution`);
});
