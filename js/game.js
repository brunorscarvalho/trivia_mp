/* Trivia Lusófono — motor do jogo (vanilla JS, sem dependências). */
(() => {
  'use strict';

  // ---------- Dados base ----------
  const CATEGORIAS = [
    { id: 'geografia',      nome: 'Geografia',          cor: 'var(--c-geo)',  emoji: '🌍' },
    { id: 'entretenimento', nome: 'Entretenimento',     cor: 'var(--c-ent)',  emoji: '🎬' },
    { id: 'historia',       nome: 'História',           cor: 'var(--c-his)',  emoji: '🏛️' },
    { id: 'arte',           nome: 'Arte & Literatura',  cor: 'var(--c-art)',  emoji: '🎨' },
    { id: 'ciencia',        nome: 'Ciência & Natureza', cor: 'var(--c-cie)',  emoji: '🔬' },
    { id: 'jogos',          nome: 'Jogos & Lazer',      cor: 'var(--c-jog)',  emoji: '🏆' },
  ];
  const CAT = Object.fromEntries(CATEGORIAS.map(c => [c.id, c]));
  const DEGRAUS = [
    { diff: 'f', nome: 'Fácil',   pontos: 100 },
    { diff: 'm', nome: 'Médio',   pontos: 300 },
    { diff: 'd', nome: 'Difícil', pontos: 500 },
  ];
  const LETRAS = ['A', 'B', 'C', 'D'];
  const TEMPO = 30;
  const STORAGE_KEY = 'trivia-lusofono:usadas';

  // ---------- Banco de perguntas ----------
  // Formato em js/perguntas/*.js: [pergunta, [correta, errada, errada, errada], curiosidade, origem?]
  const hash = s => { let h = 5381; for (const ch of s) h = ((h << 5) + h + ch.codePointAt(0)) >>> 0; return h.toString(36); };
  const BANCO = {};
  for (const c of CATEGORIAS) {
    const fonte = (window.PERGUNTAS || {})[c.id] || {};
    BANCO[c.id] = {};
    for (const d of DEGRAUS) {
      BANCO[c.id][d.diff] = (fonte[d.diff] || []).map(([q, opcoes, curiosidade, origem]) => ({
        id: c.id + ':' + hash(q), cat: c.id, diff: d.diff, q, opcoes, curiosidade, origem: origem || 'global',
      }));
    }
  }

  const store = {
    ler() { try { return new Set(JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')); } catch { return new Set(); } },
    gravar(set) { try { localStorage.setItem(STORAGE_KEY, JSON.stringify([...set])); } catch { /* sem storage: ignora */ } },
  };
  const usadas = store.ler();

  const baralhar = arr => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  };
  const sortear = arr => arr[Math.floor(Math.random() * arr.length)];

  function tirarPergunta(cat, diff, excluirId) {
    const todas = BANCO[cat][diff];
    let livres = todas.filter(p => !usadas.has(p.id) && p.id !== excluirId);
    if (!livres.length) { // célula esgotada: recomeça só esta célula
      todas.forEach(p => usadas.delete(p.id));
      livres = todas.filter(p => p.id !== excluirId);
    }
    const p = sortear(livres);
    usadas.add(p.id); store.gravar(usadas);
    const ordem = baralhar([0, 1, 2, 3]);
    return { ...p, opcoes: ordem.map(i => p.opcoes[i]), certa: ordem.indexOf(0) };
  }

  // ---------- Estado ----------
  let S = null;            // estado do jogo
  let timerId = null;
  let config = { modo: 'duo', nivel: 'm', nomes: ['Portugal', 'Brasil'], bandeiras: ['🇵🇹', '🇧🇷'], alvo: 6, timer: true, ia: [null, null] };
  let rapido = false; // testes automáticos: sem esperas

  // ---------- Oponente AI (simulado no browser, sem rede) ----------
  const BOT = { nome: 'Atlas', bandeira: '🤖' };
  const NIVEIS_IA = {
    f: { nome: 'Fácil',   p: { f: 0.75, m: 0.45, d: 0.20 }, cautela: 0.25, ajudas: 0.5 },
    m: { nome: 'Médio',   p: { f: 0.88, m: 0.65, d: 0.40 }, cautela: 0.05, ajudas: 0.75 },
    d: { nome: 'Difícil', p: { f: 0.95, m: 0.82, d: 0.60 }, cautela: -0.1, ajudas: 0.9 },
  };
  const FALAS = {
    pensar: ['Hum…', 'Boa pergunta…', 'Esta conheço!', 'Calma, calma…', 'Já li sobre isto.', 'Hum, entre duas…'],
    ajuda: ['Preciso de ajuda nesta.', 'Vou usar uma ajuda.', 'Melhor não arriscar às cegas.'],
    arriscar: ['Vou arriscar!', 'Mais uma!', 'Quem não arrisca não petisca.', 'Estou com sorte hoje.'],
    guardar: ['Melhor guardar.', 'Pontos no bolso.', 'Não vou abusar da sorte.'],
    certo: ['Isso!', 'Fácil.', 'Eu sabia!', 'Ufa!'],
    errado: ['Ai…', 'Essa não!', 'Enganei-me… ou me enganei.', 'Fica para a próxima.'],
  };

  function novoJogo() {
    const inicial = Math.random() < 0.5 ? 0 : 1;
    S = {
      id: Math.random(),
      jogadores: config.nomes.map((nome, i) => ({
        nome: config.ia[i] ? BOT.nome : (nome.trim() || ['Jogador 1', 'Jogador 2'][i]),
        bandeira: config.ia[i] ? BOT.bandeira : config.bandeiras[i],
        ia: config.ia[i] || null,
        pontos: 0, queijos: [], ajudas: { cinquenta: true, publico: true, trocar: true },
        acertos: 0, erros: 0,
      })),
      inicial, atual: inicial, ronda: 1,
      alvo: config.alvo, timer: config.timer,
      fase: 'roleta', cat: null, degrau: 0, potePontos: 0,
      pergunta: null, escolha: null, ocultas: [], publico: null, tempo: TEMPO,
      ultimaRonda: false, rodaAngulo: 0,
      solo: config.ia.some(Boolean), iaPend: false, fala: '', aviso: '',
    };
    render();
  }

  const J = () => S.jogadores[S.atual];

  // ---------- Fluxo ----------
  function girarRoleta() {
    if (S.fase !== 'roleta') return;
    S.fase = 'girando';
    const segs = CATEGORIAS.length + 1; // +1 = escolha livre
    const alvo = Math.floor(Math.random() * segs);
    const a = 360 / segs;
    const base = Math.ceil(S.rodaAngulo / 360) * 360 + 360 * 5;
    S.rodaAngulo = base - (alvo + 0.5) * a + (Math.random() - 0.5) * a * 0.6;
    const reduzido = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const roda = document.querySelector('.roda');
    if (roda) roda.style.transform = `rotate(${S.rodaAngulo}deg)`;
    setTimeout(() => {
      if (alvo === CATEGORIAS.length) { S.fase = 'escolher'; render(); }
      else iniciarCategoria(CATEGORIAS[alvo].id);
    }, rapido ? 0 : reduzido ? 200 : 3200);
    render(true);
  }

  function iniciarCategoria(cat) {
    S.cat = cat; S.degrau = 0; S.potePontos = 0;
    S.fase = 'apresentar'; render();
  }

  function proximaPergunta(trocar = false) {
    const excluir = trocar ? S.pergunta.id : null;
    S.pergunta = tirarPergunta(S.cat, DEGRAUS[S.degrau].diff, excluir);
    S.escolha = null; S.ocultas = []; S.publico = null; S.tempo = TEMPO;
    S.fase = 'pergunta';
    render();
    iniciarTimer();
  }

  function iniciarTimer() {
    pararTimer();
    if (!S.timer || J().ia) return;
    timerId = setInterval(() => {
      S.tempo--;
      const el = document.querySelector('.timer');
      if (el) { el.textContent = S.tempo; el.classList.toggle('urgente', S.tempo <= 5); el.style.setProperty('--p', S.tempo / TEMPO); }
      if (S.tempo <= 0) responder(-1);
    }, 1000);
  }
  function pararTimer() { clearInterval(timerId); timerId = null; }

  function responder(i) {
    if (S.fase !== 'pergunta' || S.ocultas.includes(i)) return;
    pararTimer();
    S.escolha = i;
    const certo = i === S.pergunta.certa;
    const j = J();
    if (certo) {
      j.acertos++;
      S.potePontos += DEGRAUS[S.degrau].pontos;
      if (S.degrau === DEGRAUS.length - 1) {
        j.pontos += S.potePontos;
        const novo = !j.queijos.includes(S.cat);
        if (novo) j.queijos.push(S.cat);
        S.resultado = { tipo: 'queijo', novo };
      } else {
        S.resultado = { tipo: 'certo' };
      }
    } else {
      j.erros++;
      S.resultado = { tipo: i === -1 ? 'tempo' : 'errado', perdidos: S.potePontos };
      S.potePontos = 0;
    }
    S.fase = 'revelar';
    render();
  }

  function arriscar() { S.degrau++; proximaPergunta(); }

  function guardar() {
    J().pontos += S.potePontos;
    S.resultado = { tipo: 'guardou', pontos: S.potePontos };
    S.potePontos = 0;
    fimDeTurno();
  }

  function fimDeTurno() {
    // Vitória: quem completa os queijos ganha — mas o segundo a jogar tem sempre direito à mesma quantidade de turnos.
    const j = J();
    const segundo = 1 - S.inicial;
    if (j.queijos.length >= S.alvo && !S.ultimaRonda) {
      if (S.atual === S.inicial) { S.ultimaRonda = true; }
      else return terminar();
    } else if (S.ultimaRonda && S.atual === segundo) {
      return terminar();
    }
    S.atual = 1 - S.atual;
    if (S.atual === S.inicial) S.ronda++;
    S.cat = null; S.pergunta = null; S.fala = '';
    if (S.solo) {
      const r = S.resultado, quem = S.jogadores[1 - S.atual];
      S.aviso = r && r.tipo === 'guardou' ? `${quem.bandeira} ${quem.nome} guardou ${r.pontos} pts.` : '';
      S.resultado = null;
      S.fase = 'roleta';
    } else S.fase = 'passar';
    render();
  }

  function terminar() {
    S.fase = 'fim';
    const [a, b] = S.jogadores;
    const ka = a.queijos.length, kb = b.queijos.length;
    S.vencedor = ka !== kb ? (ka > kb ? 0 : 1) : a.pontos !== b.pontos ? (a.pontos > b.pontos ? 0 : 1) : -1;
    render();
  }

  // ---------- Ajudas ----------
  function usarAjuda(tipo) {
    const j = J();
    if (S.fase !== 'pergunta' || !j.ajudas[tipo]) return;
    j.ajudas[tipo] = false;
    if (tipo === 'cinquenta') {
      const erradas = [0, 1, 2, 3].filter(i => i !== S.pergunta.certa);
      S.ocultas = baralhar(erradas).slice(0, 2);
      render(true);
    } else if (tipo === 'publico') {
      const visiveis = [0, 1, 2, 3].filter(i => !S.ocultas.includes(i));
      const faixa = { f: [55, 85], m: [40, 70], d: [28, 55] }[S.pergunta.diff];
      // O público às vezes engana-se nas difíceis.
      const enganado = S.pergunta.diff === 'd' && Math.random() < 0.2;
      const pesos = {};
      let resto = 100;
      const favorita = enganado ? sortear(visiveis.filter(i => i !== S.pergunta.certa)) : S.pergunta.certa;
      pesos[favorita] = Math.round(faixa[0] + Math.random() * (faixa[1] - faixa[0]));
      resto -= pesos[favorita];
      const outras = visiveis.filter(i => i !== favorita);
      const r = outras.map(() => Math.random() + 0.2);
      const soma = r.reduce((x, y) => x + y, 0);
      outras.forEach((i, k) => { pesos[i] = k === outras.length - 1 ? resto : Math.round(resto * r[k] / soma); resto -= k === outras.length - 1 ? 0 : pesos[i]; });
      S.publico = [0, 1, 2, 3].map(i => pesos[i] || 0);
      render(true);
    } else if (tipo === 'trocar') {
      proximaPergunta(true);
    }
  }

  // ---------- Jogadas do bot ----------
  const pausa = (min, max) => rapido ? 0 : (min + Math.random() * (max - min)) * (matchMedia('(prefers-reduced-motion: reduce)').matches ? 0.6 : 1);

  function agendarIA() {
    if (!S || S.iaPend || !J()?.ia) return;
    const fase = S.fase;
    if (!['roleta', 'escolher', 'apresentar', 'pergunta', 'revelar'].includes(fase)) return;
    const espera = { roleta: [700, 1200], escolher: [900, 1500], apresentar: [800, 1300], pergunta: [1600, 2800], revelar: [2600, 3600] }[fase];
    const id = S.id;
    S.iaPend = true;
    setTimeout(() => {
      if (!S || S.id !== id) return; // jogo terminado ou reiniciado entretanto
      S.iaPend = false;
      if (S.fase === fase) jogadaIA();
    }, pausa(...espera));
  }

  function jogadaIA() {
    const j = J(), nivel = NIVEIS_IA[j.ia];
    switch (S.fase) {
      case 'roleta': return girarRoleta();
      case 'escolher': {
        const faltam = CATEGORIAS.filter(c => !j.queijos.includes(c.id));
        return iniciarCategoria(sortear(faltam.length ? faltam : CATEGORIAS).id);
      }
      case 'apresentar': return proximaPergunta();
      case 'pergunta': {
        const p = S.pergunta;
        if (p.iaSabe === undefined) p.iaSabe = Math.random() < nivel.p[p.diff];
        const podeAjudar = !p.iaSabe && p.diff !== 'f' && !p.iaAjudou && Math.random() < nivel.ajudas;
        if (podeAjudar) {
          const tipo = ['cinquenta', 'publico', 'trocar'].find(t => j.ajudas[t]);
          if (tipo) {
            S.fala = sortear(FALAS.ajuda);
            if (tipo === 'trocar') { usarAjuda('trocar'); return; }
            p.iaAjudou = true;
            usarAjuda(tipo);
            return agendarIA();
          }
        }
        const visiveis = [0, 1, 2, 3].filter(i => !S.ocultas.includes(i));
        let escolha;
        if (p.iaSabe) escolha = p.certa;
        else if (S.publico) escolha = visiveis.reduce((a, b) => (S.publico[b] > S.publico[a] ? b : a));
        else escolha = sortear(visiveis);
        S.fala = '';
        responder(escolha);
        S.fala = sortear(escolha === p.certa ? FALAS.certo : FALAS.errado);
        return render();
      }
      case 'revelar': {
        if (S.resultado.tipo !== 'certo') { S.resultado = null; return fimDeTurno(); }
        const prox = DEGRAUS[S.degrau + 1];
        const temAjuda = Object.values(j.ajudas).some(Boolean);
        const pAcerto = Math.min(0.97, nivel.p[prox.diff] + (temAjuda ? 0.12 : 0));
        const outro = S.jogadores[1 - S.atual];
        const precisaQueijo = !j.queijos.includes(S.cat);
        const atras = j.queijos.length < outro.queijos.length || (j.queijos.length === outro.queijos.length && j.pontos < outro.pontos);
        // O queijo é o que ganha o jogo: vale como um bónus… ou bônus… no cálculo do risco.
        const bonusQueijo = precisaQueijo ? 1500 * (prox.diff === 'd' ? 1 : nivel.p.d) : 0;
        const valeAPena = pAcerto * (S.potePontos + prox.pontos + bonusQueijo) > S.potePontos * (1 + nivel.cautela);
        if (valeAPena || (precisaQueijo && atras) || S.ultimaRonda) { S.fala = sortear(FALAS.arriscar); return arriscar(); }
        S.fala = sortear(FALAS.guardar);
        return guardar();
      }
    }
  }

  // ---------- Render ----------
  const app = document.getElementById('app');
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function queijoSVG(queijos, tamanho = 44) {
    const n = CATEGORIAS.length, r = 20, cx = 22, cy = 22;
    const fatias = CATEGORIAS.map((c, i) => {
      const a0 = (i / n) * 2 * Math.PI - Math.PI / 2, a1 = ((i + 1) / n) * 2 * Math.PI - Math.PI / 2;
      const p = (a) => `${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`;
      const tem = queijos.includes(c.id);
      return `<path d="M${cx},${cy} L${p(a0)} A${r},${r} 0 0 1 ${p(a1)} Z" fill="${tem ? c.cor : 'transparent'}" stroke="var(--line)" stroke-width="1"><title>${esc(c.nome)}${tem ? ' ✓' : ''}</title></path>`;
    }).join('');
    return `<svg class="queijo" width="${tamanho}" height="${tamanho}" viewBox="0 0 44 44" role="img" aria-label="${queijos.length} de ${n} queijos">${fatias}<circle cx="22" cy="22" r="20" fill="none" stroke="var(--gold)" stroke-width="1.5"/></svg>`;
  }

  function balaoIA() {
    const j = J();
    if (!j.ia) return '';
    const txt = S.fala || (S.fase === 'revelar' ? '' : sortear(FALAS.pensar));
    return `<p class="ia-balao" role="status"><span class="ia-avatar">${esc(j.bandeira)}</span><span><b>${esc(j.nome)}</b> · nível ${NIVEIS_IA[j.ia].nome}${txt ? ` — <i>${esc(txt)}</i>` : ''}</span><span class="ia-pontos" aria-hidden="true"><i></i><i></i><i></i></span></p>`;
  }

  function marcadorJogo() {
    return `<header class="placar">${S.jogadores.map((j, i) => `
      <div class="jog ${i === S.atual && S.fase !== 'fim' ? 'ativo' : ''}">
        ${queijoSVG(j.queijos)}
        <div class="jog-info">
          <div class="jog-nome">${esc(j.bandeira)} ${esc(j.nome)}</div>
          <div class="jog-pts"><b>${j.pontos.toLocaleString('pt')}</b> pts · ${j.queijos.length}/${S.alvo} 🧀</div>
        </div>
      </div>`).join('<div class="vs">vs</div>')}
    </header>`;
  }

  function ecraSetup() {
    return `<section class="ecra setup">
      <div class="logo"><span class="logo-q">🧀</span><h1>Trivia <em>Lusófono</em></h1><p>Um de cada lado do Atlântico. As mesmas perguntas para os dois.</p></div>
      <form id="form-setup" class="cartao">
        <fieldset class="opcoes-jogo"><legend>Modo</legend>
          <label class="pill"><input type="radio" id="modo-duo" name="modo" value="duo" ${config.modo === 'duo' ? 'checked' : ''}><span>👥 Dois jogadores</span></label>
          <label class="pill"><input type="radio" id="modo-solo" name="modo" value="solo" ${config.modo === 'solo' ? 'checked' : ''}><span>🤖 Contra o ${BOT.nome}</span></label>
        </fieldset>
        <fieldset class="opcoes-jogo" id="nivel-ia" ${config.modo === 'solo' ? '' : 'hidden'}><legend>Nível do ${BOT.nome}</legend>
          ${Object.entries(NIVEIS_IA).map(([k, n]) => `<label class="pill"><input type="radio" id="nivel-${k}" name="nivel" value="${k}" ${config.nivel === k ? 'checked' : ''}><span>${n.nome}</span></label>`).join('')}
        </fieldset>
        <div class="campos">
          ${[0, 1].map(i => `<label class="campo" id="campo-${i}" ${i === 1 && config.modo === 'solo' ? 'hidden' : ''}><span>${i === 0 && config.modo === 'solo' ? 'Nome' : `Jogador ${i + 1}`}</span>
            <div class="campo-linha"><select name="b${i}" id="b${i}" aria-label="Bandeira do jogador ${i + 1}">${['🇵🇹', '🇧🇷', '🇦🇴', '🇲🇿', '🇨🇻', '🌍'].map(b => `<option ${b === config.bandeiras[i] ? 'selected' : ''}>${b}</option>`).join('')}</select>
            <input name="n${i}" id="n${i}" value="${esc(config.nomes[i])}" maxlength="18" autocomplete="off"></div></label>`).join('')}
        </div>
        <fieldset class="opcoes-jogo"><legend>Duração</legend>
          <label class="pill"><input type="radio" id="alvo-3" name="alvo" value="3" ${config.alvo === 3 ? 'checked' : ''}><span>Curta · 3 queijos</span></label>
          <label class="pill"><input type="radio" id="alvo-6" name="alvo" value="6" ${config.alvo === 6 ? 'checked' : ''}><span>Completa · 6 queijos</span></label>
        </fieldset>
        <label class="toggle"><input type="checkbox" id="timer" name="timer" ${config.timer ? 'checked' : ''}><span>Relógio de ${TEMPO} s por pergunta</span></label>
        <button class="btn btn-ouro" type="submit">Começar</button>
      </form>
      ${window.mqtt ? `<div class="cartao festa-cta"><div><h2>🎉 Festa online</h2><p class="dica">Jogo com amigos, cada um no seu telemóvel… ou celular. Basta enviar um link, sem limite de jogadores.</p></div><button class="btn btn-ouro" type="button" id="abrir-festa">Criar sala</button></div>` : ''}
      <details class="regras cartao"><summary>Como se joga</summary>
        <ol>
          <li>Cada jogador, na sua vez, gira a roleta: sai uma categoria (ou ★ escolha livre).</li>
          <li>Cada turno é uma escada de 3 perguntas: <b>Fácil 100</b> → <b>Médio 300</b> → <b>Difícil 500</b>.</li>
          <li>Depois de cada acerto, o jogador decide: <b>guardar</b> os pontos ou <b>arriscar</b> a próxima. Quem erra perde os pontos desse turno.</li>
          <li>Acertar a difícil dá o <b>queijo</b> dessa categoria. Quem completar os queijos ganha.</li>
          <li>Cada jogador tem 3 ajudas por jogo: <b>50:50</b>, <b>Público</b> e <b>Trocar pergunta</b>.</li>
          <li>Contra o ${BOT.nome} (AI): o bot joga sozinho na vez dele, com as mesmas regras e ajudas. No nível Difícil acerta cerca de 60% das perguntas difíceis.</li>
          <li>Justiça: quem joga em segundo tem sempre direito à última jogada. Empate em queijos → decidem os pontos.</li>
        </ol>
        <p class="nota">Banco de ${Object.values(BANCO).reduce((n, c) => n + Object.values(c).reduce((m, l) => m + l.length, 0), 0)} perguntas, escritas em português neutro e pensadas para que nenhum dos lados do Atlântico tenha vantagem.</p>
      </details>
    </section>`;
  }

  function roletaHTML() {
    const segs = [...CATEGORIAS, { id: 'livre', nome: 'Escolha livre', cor: 'var(--gold)', emoji: '★' }];
    const a = 360 / segs.length;
    const grad = segs.map((c, i) => `${c.cor} ${i * a}deg ${(i + 1) * a}deg`).join(',');
    const labels = segs.map((c, i) => `<span class="roda-label" style="--rot:${(i + 0.5) * a}deg">${c.emoji}</span>`).join('');
    return `<div class="roleta"><div class="ponteiro" aria-hidden="true"></div>
      <div class="roda" style="background:conic-gradient(${grad});transform:rotate(${S.rodaAngulo}deg)">${labels}</div>
      <button class="roda-centro" id="girar" ${S.fase !== 'roleta' ? 'disabled' : ''} aria-label="Girar a roleta">${S.fase === 'girando' ? '…' : 'Girar'}</button></div>`;
  }

  function ecraRoleta() {
    const j = J();
    const faltam = CATEGORIAS.filter(c => !j.queijos.includes(c.id));
    return `<section class="ecra roleta-ecra">
      ${S.aviso ? `<p class="dica">${esc(S.aviso)}</p>` : ''}
      ${balaoIA()}
      <p class="vez">Vez de <b>${esc(j.bandeira)} ${esc(j.nome)}</b> · turno ${S.ronda}${S.ultimaRonda ? ' · <span class="alerta">última oportunidade!</span>' : ''}</p>
      ${roletaHTML()}
      <ul class="legenda">${CATEGORIAS.map(c => `<li class="${j.queijos.includes(c.id) ? 'feito' : ''}"><i style="background:${c.cor}"></i>${c.emoji} ${c.nome}</li>`).join('')}</ul>
      <p class="dica">${faltam.length ? `Faltam: ${faltam.map(c => c.emoji).join(' ')}` : 'Queijos completos — agora é pelos pontos!'}</p>
    </section>`;
  }

  function ecraEscolher() {
    const j = J();
    return `<section class="ecra">
      ${balaoIA()}
      <h2 class="titulo">★ Escolha livre</h2>
      <p class="vez">Categoria à escolha de <b>${esc(j.bandeira)} ${esc(j.nome)}</b>:</p>
      <div class="grelha-cat">${CATEGORIAS.map(c => `<button class="btn-cat ${j.queijos.includes(c.id) ? 'feito' : ''}" data-cat="${c.id}" style="--cor:${c.cor}"><span>${c.emoji}</span>${c.nome}${j.queijos.includes(c.id) ? '<small>✓ já ganho</small>' : ''}</button>`).join('')}</div>
    </section>`;
  }

  function escada() {
    return `<ol class="escada" aria-label="Escada de pontos">${DEGRAUS.map((d, i) => `
      <li class="${i === S.degrau ? 'atual' : ''} ${i < S.degrau ? 'feito' : ''}"><span>${d.nome}</span><b>${d.pontos}${i === DEGRAUS.length - 1 ? ' + 🧀' : ''}</b></li>`).reverse().join('')}</ol>`;
  }

  function ecraApresentar() {
    const c = CAT[S.cat];
    const tem = J().queijos.includes(S.cat);
    return `<section class="ecra apresentar" style="--cor:${c.cor}">
      ${balaoIA()}
      <div class="cat-grande"><span>${c.emoji}</span><h2>${c.nome}</h2></div>
      ${escada()}
      <p class="dica">${tem ? 'Este queijo já está ganho — a difícil vale só pontos.' : 'Acertar a difícil vale o queijo desta categoria.'}</p>
      <button class="btn btn-ouro" id="comecar-turno">Primeira pergunta</button>
    </section>`;
  }

  function ecraPergunta() {
    const p = S.pergunta, c = CAT[p.cat], j = J(), d = DEGRAUS[S.degrau];
    const revelar = S.fase === 'revelar';
    const opcoes = p.opcoes.map((o, i) => {
      let cls = '';
      if (S.ocultas.includes(i)) cls = 'oculta';
      if (revelar) { if (i === p.certa) cls = 'certa'; else if (i === S.escolha) cls = 'errada'; else cls += ' apagada'; }
      const pub = S.publico ? `<span class="pub-barra" style="width:${S.publico[i]}%"></span><span class="pub">${S.publico[i]}%</span>` : '';
      return `<button class="opcao ${cls}" data-i="${i}" ${revelar || S.ocultas.includes(i) ? 'disabled' : ''}><span class="letra">${LETRAS[i]}</span><span class="txt">${esc(o)}</span>${pub}</button>`;
    }).join('');
    const ajudas = `<div class="ajudas">
      <button class="ajuda" data-ajuda="cinquenta" ${!j.ajudas.cinquenta || revelar ? 'disabled' : ''} title="Elimina duas respostas erradas">50:50</button>
      <button class="ajuda" data-ajuda="publico" ${!j.ajudas.publico || revelar ? 'disabled' : ''} title="Pergunta ao público">👥</button>
      <button class="ajuda" data-ajuda="trocar" ${!j.ajudas.trocar || revelar ? 'disabled' : ''} title="Troca por outra pergunta do mesmo nível">🔄</button>
    </div>`;
    const timer = S.timer && !revelar ? `<div class="timer ${S.tempo <= 5 ? 'urgente' : ''}" style="--p:${S.tempo / TEMPO}" aria-label="Segundos restantes">${S.tempo}</div>` : '';
    let painel = '';
    if (revelar) {
      const r = S.resultado;
      const titulo = { certo: '✅ Certo!', queijo: r.novo ? '🧀 Certo — queijo ganho!' : '✅ Certo — escada completa!', errado: '❌ Errado', tempo: '⏰ Acabou o tempo' }[r.tipo];
      const sub = r.tipo === 'certo' ? `<b>${S.potePontos}</b> pts em jogo neste turno.`
        : r.tipo === 'queijo' ? `+${S.potePontos} pts guardados.`
        : r.perdidos ? `Perdidos os ${r.perdidos} pts deste turno.` : 'Passa a vez.';
      const botoes = r.tipo === 'certo'
        ? `<button class="btn" id="guardar">Guardar ${S.potePontos} pts</button><button class="btn btn-ouro" id="arriscar">Arriscar → ${DEGRAUS[S.degrau + 1].nome} (${DEGRAUS[S.degrau + 1].pontos})</button>`
        : `<button class="btn btn-ouro" id="seguir">Continuar</button>`;
      painel = `<div class="painel ${r.tipo}"><h3>${titulo}</h3><p>${sub}</p><p class="curiosidade">💡 ${esc(p.curiosidade)}</p><div class="acoes">${botoes}</div></div>`;
    }
    return `<section class="ecra pergunta-ecra" style="--cor:${c.cor}">
      <div class="pergunta-topo">
        <span class="etiqueta">${c.emoji} ${c.nome} · ${d.nome} · ${d.pontos} pts</span>
        ${timer}
      </div>
      ${balaoIA()}
      <div class="pergunta-corpo">
        <div class="pergunta-col">
          <h2 class="pergunta">${esc(p.q)}</h2>
          <div class="opcoes">${opcoes}</div>
          ${painel}
        </div>
        <aside class="lateral">${ajudas}${escada()}</aside>
      </div>
    </section>`;
  }

  function ecraPassar() {
    const j = J();
    const r = S.resultado;
    const msg = r && r.tipo === 'guardou' ? `Guardou ${r.pontos} pts.` : '';
    return `<section class="ecra passar">
      ${msg ? `<p class="dica">${S.jogadores[1 - S.atual].nome}: ${msg}</p>` : ''}
      <p class="vez-grande">Agora é a vez de</p>
      <h2 class="titulo">${esc(j.bandeira)} ${esc(j.nome)}</h2>
      ${S.ultimaRonda ? `<p class="alerta">${esc(S.jogadores[S.inicial].nome)} completou os queijos. Última oportunidade para empatar!</p>` : ''}
      <button class="btn btn-ouro" id="pronto">Começar turno</button>
    </section>`;
  }

  function ecraFim() {
    const v = S.vencedor;
    const titulo = v === -1 ? 'Empate perfeito!'
      : S.solo && S.jogadores[v].ia ? `${esc(S.jogadores[v].bandeira)} ${esc(S.jogadores[v].nome)} ganhou desta vez!`
      : `${esc(S.jogadores[v].bandeira)} ${esc(S.jogadores[v].nome)} ganha!`;
    return `<section class="ecra fim">
      <div class="trofeu">${v === -1 ? '🤝' : '🏆'}</div>
      <h2 class="titulo">${titulo}</h2>
      ${v !== -1 && S.jogadores[0].queijos.length === S.jogadores[1].queijos.length ? '<p class="dica">Empate em queijos — decidiram os pontos.</p>' : ''}
      <div class="resumo">${S.jogadores.map(j => `<div class="cartao">
        ${queijoSVG(j.queijos, 72)}
        <h3>${esc(j.bandeira)} ${esc(j.nome)}</h3>
        <p><b>${j.pontos.toLocaleString('pt')}</b> pts · ${j.queijos.length} 🧀</p>
        <p class="nota">${j.acertos} ${j.acertos === 1 ? 'certa' : 'certas'} · ${j.erros} ${j.erros === 1 ? 'errada' : 'erradas'}</p></div>`).join('')}</div>
      <div class="acoes"><button class="btn btn-ouro" id="de-novo">Jogar de novo</button><button class="btn" id="menu">Menu</button></div>
    </section>`;
  }

  function render(parcial = false) {
    if (!S) { app.innerHTML = ecraSetup(); return; }
    // Durante o giro, não redesenhar a roda (quebraria a animação CSS).
    if (parcial && S.fase === 'girando') {
      const b = document.getElementById('girar');
      if (b) { b.disabled = true; b.textContent = '…'; }
      return;
    }
    const corpo = {
      roleta: ecraRoleta, escolher: ecraEscolher, apresentar: ecraApresentar,
      pergunta: ecraPergunta, revelar: ecraPergunta, passar: ecraPassar, fim: ecraFim,
    }[S.fase]();
    app.innerHTML = (S.fase === 'fim' ? '' : marcadorJogo()) + corpo;
    app.classList.toggle('vez-ia', S.fase !== 'fim' && !!J().ia);
    agendarIA();
  }

  // ---------- Eventos ----------
  app.addEventListener('submit', e => {
    if (e.target.id !== 'form-setup') return;
    e.preventDefault();
    const f = new FormData(e.target);
    const modo = f.get('modo') === 'solo' ? 'solo' : 'duo';
    const nivel = NIVEIS_IA[f.get('nivel')] ? String(f.get('nivel')) : 'm';
    config = {
      modo, nivel, ia: [null, modo === 'solo' ? nivel : null],
      nomes: [f.get('n0'), f.get('n1')].map(String),
      bandeiras: [f.get('b0'), f.get('b1')].map(String),
      alvo: Number(f.get('alvo')) || 6,
      timer: f.get('timer') === 'on',
    };
    novoJogo();
  });

  app.addEventListener('change', e => {
    if (e.target.name !== 'modo') return;
    const solo = e.target.value === 'solo';
    document.getElementById('nivel-ia').hidden = !solo;
    document.getElementById('campo-1').hidden = solo;
    document.querySelector('#campo-0 > span').textContent = solo ? 'Nome' : 'Jogador 1';
  });

  app.addEventListener('click', e => {
    const t = e.target.closest('button');
    if (!t || t.disabled) return;
    if (t.id === 'abrir-festa') return window.Festa?.abrir();
    if (t.id === 'menu') { S = null; pararTimer(); return render(); }
    if (t.id === 'de-novo') return novoJogo();
    if (S && S.fase !== 'fim' && J().ia) return; // vez do bot: só observar
    if (t.id === 'girar') return girarRoleta();
    if (t.dataset.cat) return iniciarCategoria(t.dataset.cat);
    if (t.id === 'comecar-turno') return proximaPergunta();
    if (t.dataset.i !== undefined) return responder(Number(t.dataset.i));
    if (t.dataset.ajuda) return usarAjuda(t.dataset.ajuda);
    if (t.id === 'arriscar') return arriscar();
    if (t.id === 'guardar') return guardar();
    if (t.id === 'seguir') { S.resultado = null; return fimDeTurno(); }
    if (t.id === 'pronto') { S.fase = 'roleta'; return render(); }
    if (t.id === 'de-novo') return novoJogo();
    if (t.id === 'menu') { S = null; pararTimer(); return render(); }
  });

  document.addEventListener('keydown', e => {
    if (!S || e.target.matches('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (S.fase !== 'fim' && J().ia) return;
    const k = e.key.toUpperCase();
    if (S.fase === 'pergunta') {
      const i = '1234'.includes(k) ? Number(k) - 1 : LETRAS.indexOf(k);
      if (i >= 0) { e.preventDefault(); responder(i); }
    } else if (S.fase === 'roleta' && (k === ' ' || k === 'ENTER')) {
      e.preventDefault(); girarRoleta();
    }
  });

  // Exposto para testes automáticos.
  window.__trivia = {
    get estado() { return S; }, BANCO, CATEGORIAS, NIVEIS_IA, esc, baralhar,
    // Para testes: jogo bot-vs-bot instantâneo.
    simular(iaA, iaB, alvo = 6) { rapido = true; config = { ...config, modo: 'solo', alvo, timer: false, ia: [iaA, iaB] }; novoJogo(); },
  };

  render();
})();
