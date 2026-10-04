/* Trivia Lusófono — modo Festa online.
 * Qualquer número de jogadores entra por link e todos respondem em simultâneo.
 * Tempo real via MQTT sobre WebSocket num broker público gratuito (sem contas, sem servidor próprio).
 * O browser do anfitrião é a autoridade: sorteia perguntas, gere o relógio e calcula os pontos. */
(() => {
  'use strict';
  const T = window.__trivia;
  if (!T || !window.mqtt) return; // sem motor ou sem biblioteca (ex.: build do Artifact): não há Festa

  const { BANCO, CATEGORIAS, esc, baralhar } = T;
  const CAT = Object.fromEntries(CATEGORIAS.map(c => [c.id, c]));
  const BROKERS = ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt'];
  const PREFIXO = 'trivia-lusofono/v1/';
  const NIVEL = { f: { nome: 'Fácil', pontos: 100 }, m: { nome: 'Médio', pontos: 300 }, d: { nome: 'Difícil', pontos: 500 } };
  const LETRAS = ['A', 'B', 'C', 'D'];
  const BANDEIRAS = ['🇵🇹', '🇧🇷', '🇦🇴', '🇲🇿', '🇨🇻', '🇬🇼', '🇸🇹', '🇹🇱', '🌍'];
  const ATIVO_MS = 30000;      // sem presença há mais do que isto = inativo
  const SEM_SINAL_MS = 20000;  // jogador sem notícias do anfitrião
  const app = document.getElementById('app');

  // ---------- Utilitários ----------
  const ls = {
    ler(k, def) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch { return def; } },
    gravar(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sem storage */ } },
    apagar(k) { try { localStorage.removeItem(k); } catch { /* sem storage */ } },
  };
  const novoId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const novoCodigo = () => Array.from({ length: 6 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');
  const limparNome = s => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 18);
  const params = new URLSearchParams(location.search);
  const brokerPersonalizado = params.get('broker'); // só para testes locais

  function eu() {
    let e = ls.ler('festa:eu', null);
    if (!e || !e.id) { e = { id: novoId(), nome: '', bandeira: '🇵🇹' }; ls.gravar('festa:eu', e); }
    return e;
  }

  function linkSala(codigo, b) {
    const u = new URL(location.href);
    u.search = '';
    u.hash = '';
    u.searchParams.set('sala', codigo);
    if (brokerPersonalizado) u.searchParams.set('broker', brokerPersonalizado);
    else if (b) u.searchParams.set('b', String(b));
    return u.toString();
  }

  // ---------- Broker MQTT ----------
  let cliente = null;
  function ligar(indice, aoLigar, aoFalhar) {
    const url = brokerPersonalizado || BROKERS[indice] || BROKERS[0];
    const c = window.mqtt.connect(url, {
      clientId: 'tl_' + novoId(), clean: true, reconnectPeriod: 2000, connectTimeout: 8000, keepalive: 30,
    });
    let ligado = false;
    const desistir = setTimeout(() => { if (!ligado) { c.end(true); aoFalhar(); } }, 9000);
    c.on('connect', () => {
      if (ligado) return estadoLigacao(true);
      ligado = true; clearTimeout(desistir); cliente = c; estadoLigacao(true); aoLigar(c);
    });
    c.on('offline', () => estadoLigacao(false));
    c.on('error', () => { if (!ligado) { clearTimeout(desistir); c.end(true); aoFalhar(); } });
    return c;
  }
  let online = true;
  function estadoLigacao(ok) {
    online = ok;
    const el = document.getElementById('f-rede');
    if (el) el.hidden = ok;
  }
  const publicar = (topico, dados, retain = false) =>
    cliente && cliente.publish(PREFIXO + topico, JSON.stringify(dados), { qos: 1, retain });

  // ======================================================================
  // ANFITRIÃO
  // ======================================================================
  let H = null;          // estado completo (só no anfitrião)
  let hostTick = null;
  let pubPendente = null;

  function criarSala({ nome, bandeira, total, tempo }) {
    const e = eu();
    e.nome = nome; e.bandeira = bandeira; ls.gravar('festa:eu', e);
    H = {
      codigo: novoCodigo(), b: 0, hostId: e.id, total, tempo, fase: 'espera', n: 0,
      jogadores: { [e.id]: novoJogador(e) }, pergunta: null, respostas: {}, usadas: [], plano: [],
    };
    ecraAguarde('Um momento… a sala está quase pronta.');
    tentarBroker(0);
  }

  function tentarBroker(i) {
    if (!brokerPersonalizado && i >= BROKERS.length) return ecraErro('Servidor de tempo real indisponível. Tentar de novo dentro de momentos.');
    H.b = i;
    ligar(i, iniciarAnfitriao, () => tentarBroker(i + 1));
  }

  function novoJogador(e) {
    return { nome: limparNome(e.nome) || 'Jogador', bandeira: BANDEIRAS.includes(e.bandeira) ? e.bandeira : '🌍', pontos: 0, serie: 0, ganho: 0, visto: Date.now(), acertos: 0 };
  }

  function iniciarAnfitriao(c) {
    const base = PREFIXO + H.codigo + '/';
    c.subscribe([base + 'entrar', base + 'resposta'], { qos: 1 });
    c.on('message', (topico, msg) => {
      let d; try { d = JSON.parse(msg.toString()); } catch { return; }
      if (!d || typeof d.id !== 'string' || d.id.length > 40) return;
      if (topico === base + 'entrar') receberEntrada(d);
      else if (topico === base + 'resposta') receberResposta(d.id, d.n, d.opcao);
    });
    history.replaceState(null, '', linkSala(H.codigo, H.b));
    clearInterval(hostTick);
    hostTick = setInterval(cicloAnfitriao, 500);
    gravarAnfitriao();
    publicarEstado();
    renderAnfitriao();
  }

  function receberEntrada(d) {
    const j = H.jogadores[d.id];
    if (j) { // presença ou mudança de nome
      j.visto = Date.now();
      const nome = limparNome(d.nome);
      if (nome && nome !== j.nome) { j.nome = nome; agendarPublicacao(); }
      return;
    }
    H.jogadores[d.id] = novoJogador(d);
    agendarPublicacao();
  }

  function receberResposta(id, n, opcao) {
    const j = H.jogadores[id];
    if (!j || H.fase !== 'pergunta' || n !== H.n || H.respostas[id] || ![0, 1, 2, 3].includes(opcao)) return;
    j.visto = Date.now();
    H.respostas[id] = { opcao, t: Date.now() };
    const ativos = idsAtivos();
    if (ativos.every(i => H.respostas[i])) return revelar();
    agendarPublicacao();
  }

  const idsAtivos = () => Object.keys(H.jogadores).filter(id => id === H.hostId || Date.now() - H.jogadores[id].visto < ATIVO_MS);

  function cicloAnfitriao() {
    H.jogadores[H.hostId].visto = Date.now();
    if (H.fase === 'pergunta' && Date.now() >= H.prazo) return revelar();
    if (H.fase === 'pergunta') atualizarRelogio(H.prazo);
    if (!H.ultimaPub || Date.now() - H.ultimaPub > 5000) publicarEstado(); // sinal de vida
  }

  function planoPerguntas(total) {
    // Dificuldade sobe ao longo do jogo; categorias em rotação baralhada.
    const plano = [];
    let cats = [];
    for (let i = 0; i < total; i++) {
      if (!cats.length) cats = baralhar(CATEGORIAS.map(c => c.id));
      const diff = i < Math.ceil(total / 3) ? 'f' : i < Math.ceil(2 * total / 3) ? 'm' : 'd';
      plano.push({ cat: cats.pop(), diff });
    }
    return plano;
  }

  function tirar(cat, diff) {
    const todas = BANCO[cat][diff];
    let livres = todas.filter(p => !H.usadas.includes(p.id));
    if (!livres.length) livres = todas;
    const p = livres[Math.floor(Math.random() * livres.length)];
    H.usadas.push(p.id);
    const ordem = baralhar([0, 1, 2, 3]);
    return { cat, diff, q: p.q, opcoes: ordem.map(i => p.opcoes[i]), certa: ordem.indexOf(0), curiosidade: p.curiosidade };
  }

  function comecarJogo() {
    for (const j of Object.values(H.jogadores)) { j.pontos = 0; j.serie = 0; j.ganho = 0; j.acertos = 0; }
    H.plano = planoPerguntas(H.total);
    H.n = 0;
    proximaPergunta();
  }

  function proximaPergunta() {
    if (H.n >= H.total) { H.fase = 'fim'; publicarEstado(); return renderAnfitriao(); }
    const { cat, diff } = H.plano[H.n];
    H.n++;
    H.pergunta = tirar(cat, diff);
    H.respostas = {};
    H.inicio = Date.now();
    H.prazo = H.inicio + H.tempo * 1000;
    H.fase = 'pergunta';
    publicarEstado();
    renderAnfitriao();
  }

  function revelar() {
    if (H.fase !== 'pergunta') return;
    const p = H.pergunta, base = NIVEL[p.diff].pontos;
    for (const [id, j] of Object.entries(H.jogadores)) {
      const r = H.respostas[id];
      j.posAntes = j.pontos;
      if (r && r.opcao === p.certa) {
        const rapidez = Math.max(0, Math.min(1, (H.prazo - r.t) / (H.tempo * 1000)));
        const bonus = Math.min(j.serie, 5) * 0.1;
        j.ganho = Math.round(base * (0.5 + 0.5 * rapidez) * (1 + bonus));
        j.pontos += j.ganho; j.serie++; j.acertos++;
      } else { j.ganho = 0; j.serie = 0; }
    }
    H.fase = 'revelar';
    publicarEstado();
    renderAnfitriao();
  }

  function agendarPublicacao() {
    if (pubPendente) return;
    pubPendente = setTimeout(() => { pubPendente = null; publicarEstado(); renderAnfitriao(); }, 250);
  }

  // Estado público: a resposta certa só viaja na revelação.
  function estadoPublico() {
    const ativos = new Set(idsAtivos());
    const jogadores = Object.entries(H.jogadores).map(([id, j]) => ({
      id, nome: j.nome, bandeira: j.bandeira, pontos: j.pontos, ganho: j.ganho, serie: j.serie, acertos: j.acertos,
      ativo: ativos.has(id), respondeu: !!H.respostas[id], anfitriao: id === H.hostId,
    })).sort((a, b) => b.pontos - a.pontos || a.nome.localeCompare(b.nome));
    const e = { v: 1, codigo: H.codigo, fase: H.fase, ts: Date.now(), total: H.total, tempo: H.tempo, n: H.n, jogadores };
    if (H.pergunta && (H.fase === 'pergunta' || H.fase === 'revelar')) {
      const p = H.pergunta;
      e.pergunta = { cat: p.cat, diff: p.diff, q: p.q, opcoes: p.opcoes, restante: Math.max(0, H.prazo - Date.now()) };
      if (H.fase === 'revelar') {
        const contagem = [0, 0, 0, 0];
        const escolhas = {};
        for (const [id, r] of Object.entries(H.respostas)) { contagem[r.opcao]++; escolhas[id] = r.opcao; }
        e.revelar = { certa: p.certa, curiosidade: p.curiosidade, contagem, escolhas };
      }
    }
    return e;
  }

  function publicarEstado() {
    if (!H) return;
    H.ultimaPub = Date.now();
    publicar(H.codigo + '/estado', estadoPublico(), true);
    gravarAnfitriao();
  }

  function gravarAnfitriao() { ls.gravar('festa:anfitriao', H); }

  function retomarAnfitriao(guardado) {
    H = guardado;
    ecraAguarde('Um momento… a sala está quase pronta.');
    ligar(H.b || 0, iniciarAnfitriao, () => ecraErro('Servidor de tempo real indisponível. Tentar de novo dentro de momentos.'));
  }

  function responderAnfitriao(opcao) {
    receberResposta(H.hostId, H.n, opcao);
    renderAnfitriao();
  }

  function renderAnfitriao() {
    if (!H) return;
    const e = estadoPublico();
    renderJogo(e, H.hostId, true);
  }

  // ======================================================================
  // JOGADOR
  // ======================================================================
  let J = null; // { codigo, b, ultimo, minhaResposta: {n, opcao}, estado }
  let presenca = null, vigia = null;

  function ecraEntrar(codigo) {
    const e = eu();
    app.innerHTML = `<section class="ecra setup festa">
      <div class="logo"><span class="logo-q">🎉</span><h1>Trivia <em>Lusófono</em></h1><p>Sala <b class="codigo">${esc(codigo)}</b></p></div>
      <form id="f-form-entrar" class="cartao">
        <label class="campo"><span>Nome</span>
          <div class="campo-linha"><select id="f-bandeira" name="bandeira" aria-label="Bandeira">${BANDEIRAS.map(b => `<option ${b === e.bandeira ? 'selected' : ''}>${b}</option>`).join('')}</select>
          <input id="f-nome" name="nome" value="${esc(e.nome)}" maxlength="18" autocomplete="nickname" required placeholder="Como os outros vão ver"></div></label>
        <button class="btn btn-ouro" type="submit">Entrar na sala</button>
      </form>
      <p class="dica">Todos respondem às mesmas perguntas ao mesmo tempo. Quem acerta mais depressa ganha mais pontos.</p>
    </section>`;
    app.querySelector('#f-nome').focus();
  }

  function entrarSala(codigo, nome, bandeira) {
    const e = eu();
    e.nome = nome; e.bandeira = bandeira; ls.gravar('festa:eu', e);
    J = { codigo, b: Number(params.get('b')) || 0, ultimo: Date.now(), minhaResposta: ls.ler('festa:resp:' + codigo, null), estado: null };
    ecraAguarde('Um momento…');
    ligar(J.b, c => {
      const base = PREFIXO + codigo + '/';
      c.subscribe(base + 'estado', { qos: 1 });
      c.on('message', (topico, msg) => {
        if (topico !== base + 'estado') return;
        let d; try { d = JSON.parse(msg.toString()); } catch { return; }
        if (!d || d.v !== 1 || !Array.isArray(d.jogadores)) return;
        J.ultimo = Date.now();
        // Sinal de vida sem mudanças: não redesenhar (evita perder toques a meio).
        const chave = JSON.stringify({ ...d, ts: 0, pergunta: d.pergunta && { ...d.pergunta, restante: 0 } });
        if (chave === J.chave) return;
        J.chave = chave;
        if (d.pergunta) d.pergunta.prazoLocal = Date.now() + (Number(d.pergunta.restante) || 0);
        J.estado = d;
        renderJogador();
      });
      const anunciar = () => publicar(codigo + '/entrar', { id: e.id, nome: e.nome, bandeira: e.bandeira });
      anunciar();
      clearInterval(presenca); presenca = setInterval(anunciar, 10000);
      clearInterval(vigia); vigia = setInterval(() => {
        if (J.estado?.fase === 'pergunta') atualizarRelogio(J.estado.pergunta.prazoLocal);
        const aviso = document.getElementById('f-sem-sinal');
        if (aviso) aviso.hidden = Date.now() - J.ultimo < SEM_SINAL_MS;
      }, 500);
      // Sem estado ao fim de uns segundos: sala inexistente.
      setTimeout(() => { if (!J.estado) ecraErro('Sala não encontrada. Confirme o link com quem criou a sala.'); }, 7000);
    }, () => ecraErro('Servidor de tempo real indisponível. Tentar de novo dentro de momentos.'));
  }

  function responderJogador(opcao) {
    const s = J.estado;
    if (!s || s.fase !== 'pergunta' || (J.minhaResposta && J.minhaResposta.n === s.n)) return;
    J.minhaResposta = { n: s.n, opcao };
    ls.gravar('festa:resp:' + J.codigo, J.minhaResposta);
    publicar(J.codigo + '/resposta', { id: eu().id, n: s.n, opcao });
    renderJogador();
  }

  function renderJogador() {
    if (!J || !J.estado) return;
    const meuId = eu().id;
    if (!J.estado.jogadores.some(j => j.id === meuId) && J.estado.fase !== 'fim') {
      return ecraAguarde('Um momento…');
    }
    renderJogo(J.estado, meuId, false);
  }

  // ======================================================================
  // ECRÃS (partilhados por anfitrião e jogadores)
  // ======================================================================
  function ecraAguarde(msg) {
    app.innerHTML = `<section class="ecra festa"><div class="festa-espera"><span class="ia-pontos"><i></i><i></i><i></i></span><p>${esc(msg)}</p></div></section>`;
  }
  function ecraErro(msg) {
    app.innerHTML = `<section class="ecra festa"><div class="cartao festa-erro"><h2>⚠️ Sem jogo</h2><p>${esc(msg)}</p>
      <div class="acoes"><button class="btn btn-ouro" id="f-recarregar">Tentar de novo</button><button class="btn" id="f-sair">Menu</button></div></div></section>`;
  }

  function avisos() {
    return `<p class="festa-aviso" id="f-rede" ${online ? 'hidden' : ''}>Sem rede. Nova tentativa em curso…</p>
      ${H ? '' : `<p class="festa-aviso" id="f-sem-sinal" hidden>Sem sinal do anfitrião. Se não voltar, a sala terminou.</p>`}`;
  }

  function linhaRanking(j, meuId, i, mostrarGanho) {
    return `<li class="${j.id === meuId ? 'eu' : ''} ${j.ativo ? '' : 'inativo'}">
      <span class="pos">${i + 1}</span><span class="nome">${esc(j.bandeira)} ${esc(j.nome)}${j.anfitriao ? ' <small>anfitrião</small>' : ''}${j.id === meuId ? ' <small>(eu)</small>' : ''}</span>
      ${mostrarGanho ? `<span class="ganho ${j.ganho ? 'mais' : ''}">${j.ganho ? '+' + j.ganho : '—'}</span>` : ''}
      <b class="pts">${j.pontos.toLocaleString('pt')}</b></li>`;
  }

  function cabecalho(e) {
    return `<header class="festa-topo"><span class="codigo-sala">Sala <b>${esc(e.codigo)}</b></span>
      <span>${e.jogadores.length} ${e.jogadores.length === 1 ? 'jogador' : 'jogadores'}</span>
      ${e.n && e.fase !== 'espera' ? `<span>Pergunta ${e.n} de ${e.total}</span>` : ''}</header>`;
  }

  function renderJogo(e, meuId, souAnfitriao) {
    const corpo = { espera: ecraSala, pergunta: ecraPergunta, revelar: ecraPergunta, fim: ecraPodio }[e.fase];
    if (!corpo) return;
    const ativo = document.activeElement?.id;
    app.innerHTML = `<section class="ecra festa">${cabecalho(e)}${avisos()}${corpo(e, meuId, souAnfitriao)}</section>`;
    if (ativo === 'f-link') document.getElementById('f-link')?.focus();
  }

  function ecraSala(e, meuId, souAnfitriao) {
    const lista = `<ul class="festa-lista">${e.jogadores.map(j => `<li class="${j.id === meuId ? 'eu' : ''} ${j.ativo ? '' : 'inativo'}">${esc(j.bandeira)} ${esc(j.nome)}${j.anfitriao ? ' <small>anfitrião</small>' : ''}</li>`).join('')}</ul>`;
    if (!souAnfitriao) {
      return `<div class="cartao festa-centro"><h2 class="titulo">Dentro da sala! 🎉</h2>
        <p class="dica">O jogo começa quando o anfitrião der o sinal.</p></div>
        <h3 class="festa-sub">Na sala (${e.jogadores.length})</h3>${lista}`;
    }
    const link = linkSala(H.codigo, H.b);
    let qr = '';
    try { const q = window.qrcode(0, 'M'); q.addData(link); q.make(); qr = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); } catch { /* sem QR */ }
    return `<div class="festa-convite cartao">
        <div class="convite-texto">
          <h2>Convidar amigos</h2>
          <p class="dica">Quem abrir este link escolhe o nome e entra. Sem limite de jogadores.</p>
          <div class="link-linha"><input id="f-link" readonly value="${esc(link)}" aria-label="Link da sala"><button class="btn btn-ouro" id="f-copiar">Copiar</button></div>
          ${navigator.share ? '<button class="btn" id="f-enviar">Enviar link…</button>' : ''}
          <p class="nota" id="f-copiado" hidden>Link copiado ✓</p>
        </div>
        ${qr ? `<div class="qr" aria-label="Código QR do link">${qr}</div>` : ''}
      </div>
      <h3 class="festa-sub">Na sala (${e.jogadores.length})</h3>${lista}
      <p class="dica">${e.total} perguntas · ${e.tempo} s cada · a dificuldade sobe ao longo do jogo</p>
      <button class="btn btn-ouro btn-grande" id="f-comecar">Começar jogo</button>`;
  }

  function ecraPergunta(e, meuId, souAnfitriao) {
    const p = e.pergunta, c = CAT[p.cat], nv = NIVEL[p.diff], r = e.revelar;
    const minha = souAnfitriao ? (H.respostas[meuId]?.opcao ?? null) : (J.minhaResposta && J.minhaResposta.n === e.n ? J.minhaResposta.opcao : null);
    const eu_ = e.jogadores.find(j => j.id === meuId);
    const total = e.jogadores.filter(j => j.ativo).length;
    const responderam = e.jogadores.filter(j => j.respondeu).length;
    const opcoes = p.opcoes.map((o, i) => {
      let cls = '';
      if (r) cls = i === r.certa ? 'certa' : i === minha ? 'errada' : 'apagada';
      else if (minha === i) cls = 'escolhida';
      const barra = r ? `<span class="pub-barra" style="width:${Math.round(100 * r.contagem[i] / Math.max(1, responderam))}%"></span><span class="pub">${r.contagem[i]}</span>` : '';
      return `<button class="opcao ${cls}" data-f-opcao="${i}" ${r || minha !== null ? 'disabled' : ''}><span class="letra">${LETRAS[i]}</span><span class="txt">${esc(o)}</span>${barra}</button>`;
    }).join('');
    let rodape;
    if (!r) {
      rodape = `<p class="dica">${minha !== null ? 'Resposta enviada ✓ · ' : ''}${responderam} de ${total} já responderam</p>
        ${souAnfitriao ? '<button class="btn" id="f-revelar">Fechar pergunta agora</button>' : ''}`;
    } else {
      const acertei = minha === r.certa;
      const titulo = minha === null ? '⏰ Sem resposta' : acertei ? `✅ Certo! +${eu_?.ganho || 0} pts` : '❌ Errado';
      const serie = acertei && eu_?.serie >= 2 ? `<p class="nota">🔥 ${eu_.serie} certas seguidas</p>` : '';
      rodape = `<div class="painel ${acertei ? 'certo' : 'errado'}"><h3>${titulo}</h3>${serie}<p class="curiosidade">💡 ${esc(r.curiosidade)}</p></div>
        <h3 class="festa-sub">Classificação</h3>
        <ol class="festa-ranking">${e.jogadores.map((j, i) => linhaRanking(j, meuId, i, true)).join('')}</ol>
        ${souAnfitriao ? `<button class="btn btn-ouro btn-grande" id="f-proxima">${e.n >= e.total ? 'Ver pódio' : 'Próxima pergunta'}</button>`
          : '<p class="dica">O anfitrião avança para a próxima pergunta.</p>'}`;
    }
    return `<div class="pergunta-ecra" style="--cor:${c.cor}">
      <div class="pergunta-topo"><span class="etiqueta">${c.emoji} ${c.nome} · ${nv.nome} · até ${Math.round(nv.pontos * 1.5)} pts</span>
        ${r ? '' : `<div class="timer" id="f-timer" style="--p:1">${e.tempo}</div>`}</div>
      <h2 class="pergunta">${esc(p.q)}</h2>
      <div class="opcoes">${opcoes}</div>
      ${rodape}
    </div>`;
  }

  function ecraPodio(e, meuId, souAnfitriao) {
    const top = e.jogadores.slice(0, 3);
    const medalhas = ['🥇', '🥈', '🥉'];
    const pos = e.jogadores.findIndex(j => j.id === meuId);
    return `<div class="podio">${[1, 0, 2].filter(i => top[i]).map(i => `
        <div class="degrau-podio p${i + 1}"><span class="medalha">${medalhas[i]}</span>
          <b>${esc(top[i].bandeira)} ${esc(top[i].nome)}</b><span>${top[i].pontos.toLocaleString('pt')} pts</span><div class="bloco">${i + 1}</div></div>`).join('')}
      </div>
      ${pos >= 0 ? `<p class="dica">Ficou em <b>${pos + 1}.º lugar</b> de ${e.jogadores.length}, com ${e.jogadores[pos].acertos} de ${e.total} certas.</p>` : ''}
      <ol class="festa-ranking">${e.jogadores.map((j, i) => linhaRanking(j, meuId, i, false)).join('')}</ol>
      <div class="acoes">${souAnfitriao ? '<button class="btn btn-ouro" id="f-de-novo">Jogar de novo (mesma sala)</button>' : '<p class="dica">Se o anfitrião começar outro jogo, entra automaticamente.</p>'}
        <button class="btn" id="f-sair">Sair</button></div>`;
  }

  function atualizarRelogio(prazo) {
    const el = document.getElementById('f-timer');
    if (!el) return;
    const tempo = (H || J?.estado)?.tempo || 20;
    const s = Math.max(0, Math.ceil((prazo - Date.now()) / 1000));
    el.textContent = s;
    el.style.setProperty('--p', Math.min(1, s / tempo));
    el.classList.toggle('urgente', s <= 5);
  }

  // ---------- Menu do anfitrião ----------
  function ecraCriar() {
    const e = eu();
    app.innerHTML = `<section class="ecra setup festa">
      <div class="logo"><span class="logo-q">🎉</span><h1>Festa <em>online</em></h1><p>Uma sala, um link, e cada amigo entra pelo próprio telemóvel… ou celular.</p></div>
      <form id="f-form-criar" class="cartao">
        <label class="campo"><span>Nome (o anfitrião também joga)</span>
          <div class="campo-linha"><select id="f-bandeira" name="bandeira" aria-label="Bandeira">${BANDEIRAS.map(b => `<option ${b === e.bandeira ? 'selected' : ''}>${b}</option>`).join('')}</select>
          <input id="f-nome" name="nome" value="${esc(e.nome)}" maxlength="18" required></div></label>
        <fieldset class="opcoes-jogo"><legend>Perguntas</legend>
          ${[10, 15, 20].map(n => `<label class="pill"><input type="radio" id="f-total-${n}" name="total" value="${n}" ${n === 10 ? 'checked' : ''}><span>${n}</span></label>`).join('')}
        </fieldset>
        <fieldset class="opcoes-jogo"><legend>Tempo por pergunta</legend>
          ${[15, 20, 30].map(n => `<label class="pill"><input type="radio" id="f-tempo-${n}" name="tempo" value="${n}" ${n === 20 ? 'checked' : ''}><span>${n} s</span></label>`).join('')}
        </fieldset>
        <button class="btn btn-ouro" type="submit">Criar sala</button>
        <button class="btn" type="button" id="f-sair">Voltar</button>
      </form>
    </section>`;
  }

  // ---------- Eventos ----------
  app.addEventListener('submit', ev => {
    const f = ev.target;
    if (f.id !== 'f-form-criar' && f.id !== 'f-form-entrar') return;
    ev.preventDefault();
    const d = new FormData(f);
    const nome = limparNome(d.get('nome'));
    if (!nome) return f.querySelector('#f-nome').focus();
    const bandeira = String(d.get('bandeira'));
    if (f.id === 'f-form-criar') criarSala({ nome, bandeira, total: Number(d.get('total')) || 10, tempo: Number(d.get('tempo')) || 20 });
    else entrarSala(params.get('sala').toUpperCase(), nome, bandeira);
  });

  app.addEventListener('click', ev => {
    const t = ev.target.closest('button');
    if (!t || t.disabled) return;
    if (t.dataset.fOpcao !== undefined) {
      const i = Number(t.dataset.fOpcao);
      return H ? responderAnfitriao(i) : responderJogador(i);
    }
    switch (t.id) {
      case 'f-comecar': return comecarJogo();
      case 'f-revelar': return revelar();
      case 'f-proxima': return proximaPergunta();
      case 'f-de-novo': H.fase = 'espera'; H.n = 0; H.pergunta = null; publicarEstado(); return comecarJogo();
      case 'f-copiar': return copiarLink();
      case 'f-enviar': return navigator.share({ title: 'Trivia Lusófono', text: 'Entra no meu jogo de trivia!', url: document.getElementById('f-link').value }).catch(() => {});
      case 'f-recarregar': return location.reload();
      case 'f-sair':
        if (H) ls.apagar('festa:anfitriao');
        cliente?.end(true);
        location.href = location.pathname;
    }
  });

  document.addEventListener('keydown', ev => {
    if (ev.target.matches('input, select, textarea') || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const fase = H ? H.fase : J?.estado?.fase;
    if (fase !== 'pergunta') return;
    const k = ev.key.toUpperCase();
    const i = '1234'.includes(k) ? Number(k) - 1 : LETRAS.indexOf(k);
    if (i >= 0) { ev.preventDefault(); H ? responderAnfitriao(i) : responderJogador(i); }
  });

  function copiarLink() {
    const input = document.getElementById('f-link');
    const ok = () => { const n = document.getElementById('f-copiado'); if (n) n.hidden = false; };
    (navigator.clipboard?.writeText(input.value) || Promise.reject()).then(ok, () => { input.select(); try { document.execCommand('copy'); ok(); } catch { /* o texto fica selecionado */ } });
  }

  // ---------- Arranque ----------
  window.Festa = { abrir: ecraCriar, get anfitriao() { return H; }, get jogador() { return J; } };

  const sala = params.get('sala');
  if (sala && /^[A-Z0-9]{4,8}$/i.test(sala)) {
    const guardado = ls.ler('festa:anfitriao', null);
    if (guardado && guardado.codigo === sala.toUpperCase() && guardado.hostId === eu().id) retomarAnfitriao(guardado);
    else if (eu().nome && ls.ler('festa:ultima-sala', '') === sala.toUpperCase()) entrarSala(sala.toUpperCase(), eu().nome, eu().bandeira);
    else ecraEntrar(sala.toUpperCase());
    ls.gravar('festa:ultima-sala', sala.toUpperCase());
  }
})();
