// ══════════════════════════════════════════════════════════
// CASA DESENVOLVIMENTO IMOBILIÁRIO — CRM Backend
// ══════════════════════════════════════════════════════════
const express = require('express');
const cors    = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

// ── ENV ──────────────────────────────────────────────────
const PORT            = process.env.PORT || 3000;
const WA_VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN || 'casa_crm_token_2024';
const WA_ACCESS_TOKEN = process.env.WA_ACCESS_TOKEN || ''; // Meta permanent token
const SUPABASE_URL    = process.env.SUPABASE_URL    || '';
const SUPABASE_KEY    = process.env.SUPABASE_KEY    || '';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── HEALTH ───────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Casa CRM Backend', ts: new Date().toISOString() });
});

// ══════════════════════════════════════════════════════════
// WHATSAPP WEBHOOK — verificação (GET)
// ══════════════════════════════════════════════════════════
app.get('/webhook/whatsapp', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === WA_VERIFY_TOKEN) {
    console.log('✅ Webhook WhatsApp verificado');
    res.status(200).send(challenge);
  } else {
    res.status(403).json({ error: 'Token inválido' });
  }
});

// ══════════════════════════════════════════════════════════
// WHATSAPP WEBHOOK — receber mensagens (POST)
// ══════════════════════════════════════════════════════════
app.post('/webhook/whatsapp', async (req, res) => {
  res.status(200).send('OK'); // responde 200 imediatamente (obrigatório pela Meta)

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value;
        if (!value || !value.messages) continue;

        for (const msg of value.messages) {
          if (msg.type !== 'text') continue; // só processa texto por enquanto

          const phone   = msg.from; // ex: 5551999990000
          const text    = msg.text?.body || '';
          const contact = value.contacts?.[0];
          const name    = contact?.profile?.name || phone;

          console.log(`📩 Mensagem de ${name} (${phone}): ${text.slice(0, 60)}`);

          await processarLead({ phone, name, text });
        }
      }
    }
  } catch (err) {
    console.error('Erro no webhook:', err.message);
  }
});

// ══════════════════════════════════════════════════════════
// LÓGICA: criar ou atualizar lead
// ══════════════════════════════════════════════════════════
async function processarLead({ phone, name, text }) {
  // 1. Verifica se já existe lead com esse telefone
  const { data: existing } = await supabase
    .from('leads')
    .select('*')
    .eq('phone', phone)
    .eq('deleted', false)
    .limit(1);

  if (existing && existing.length > 0) {
    // Lead já existe — adiciona anotação no histórico
    const lead = existing[0];
    const history = lead.history || [];
    history.push({
      date: nowStr(),
      text: `📱 WhatsApp: "${text.slice(0, 200)}"`
    });

    await supabase
      .from('leads')
      .update({ history, updated_at: new Date().toISOString() })
      .eq('id', lead.id);

    console.log(`♻️  Lead existente atualizado: ${lead.name}`);
    return;
  }

  // 2. Detecta interesse pelo texto da mensagem
  const interest = detectarInteresse(text);

  // 3. Cria novo lead
  const novoLead = {
    id:          uid(),
    name:        name,
    phone:       formatarTelefone(phone),
    phone_raw:   phone,
    interest:    interest,
    emp:         'Maré Empreendimentos',
    stage:       'novo',
    raw_value:   0,
    history:     [{ date: nowStr(), text: `📱 Primeiro contato via WhatsApp: "${text.slice(0, 200)}"` }],
    deleted:     false,
    created_at:  new Date().toISOString(),
    updated_at:  new Date().toISOString(),
    source:      'WhatsApp'
  };

  const { error } = await supabase.from('leads').insert([novoLead]);
  if (error) {
    console.error('Erro ao criar lead:', error.message);
  } else {
    console.log(`✅ Novo lead criado: ${name} (${phone}) — Interesse: ${interest}`);
  }
}

// ══════════════════════════════════════════════════════════
// APIS REST — para o CRM consultar
// ══════════════════════════════════════════════════════════

// GET /leads — retorna todos os leads
app.get('/leads', async (req, res) => {
  const emp = req.query.emp; // filtro opcional por empreendimento
  let query = supabase.from('leads').select('*').eq('deleted', false).order('created_at', { ascending: false });
  if (emp && emp !== 'all') query = query.eq('emp', emp);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET /leads/:id
app.get('/leads/:id', async (req, res) => {
  const { data, error } = await supabase.from('leads').select('*').eq('id', req.params.id).single();
  if (error) return res.status(404).json({ error: 'Lead não encontrado' });
  res.json(data);
});

// POST /leads — criar lead manualmente
app.post('/leads', async (req, res) => {
  const lead = {
    ...req.body,
    id:         uid(),
    deleted:    false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    source:     req.body.source || 'Manual'
  };
  const { data, error } = await supabase.from('leads').insert([lead]).select();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data[0]);
});

// PATCH /leads/:id — atualizar lead
app.patch('/leads/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('leads')
    .update({ ...req.body, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data[0]);
});

// DELETE /leads/:id — soft delete
app.delete('/leads/:id', async (req, res) => {
  const { error } = await supabase
    .from('leads')
    .update({ deleted: true, updated_at: new Date().toISOString() })
    .eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// GET /tasks
app.get('/tasks', async (req, res) => {
  const { data, error } = await supabase.from('tasks').select('*').order('date', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /tasks
app.post('/tasks', async (req, res) => {
  const task = { ...req.body, id: uid(), created_at: new Date().toISOString() };
  const { data, error } = await supabase.from('tasks').insert([task]).select();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data[0]);
});

// PATCH /tasks/:id
app.patch('/tasks/:id', async (req, res) => {
  const { data, error } = await supabase.from('tasks').update(req.body).eq('id', req.params.id).select();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data[0]);
});

// DELETE /tasks/:id
app.delete('/tasks/:id', async (req, res) => {
  const { error } = await supabase.from('tasks').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// GET /stats — dashboard rápido
app.get('/stats', async (req, res) => {
  const emp = req.query.emp;
  let q = supabase.from('leads').select('stage, raw_value').eq('deleted', false);
  if (emp && emp !== 'all') q = q.eq('emp', emp);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  const by = s => data.filter(l => l.stage === s).length;
  res.json({
    total:      data.length,
    novo:       by('novo'),
    contato:    by('contato'),
    visita:     by('visita'),
    proposta:   by('proposta'),
    negociacao: by('negociacao'),
    fechado:    by('fechado'),
    perdido:    by('perdido'),
    vgv:        data.reduce((s, l) => s + (l.raw_value || 0), 0)
  });
});

// ══════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════
function uid() {
  return Date.now() + '-' + Math.random().toString(36).slice(2, 8);
}

function nowStr() {
  return new Date().toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo'
  });
}

function formatarTelefone(raw) {
  // 5551999990000 → (51) 99999-0000
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

// ══════════════════════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`🚀 Casa CRM Backend rodando na porta ${PORT}`);
  console.log(`📡 Webhook WhatsApp: POST /webhook/whatsapp`);
  console.log(`🔑 Verify token: ${WA_VERIFY_TOKEN}`);
});
