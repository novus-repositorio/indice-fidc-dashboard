(function () {
  'use strict';

  // ---------- tema (mesmo padrão das outras páginas) ----------
  const botaoTema = document.getElementById('botao-tema');
  function temaAtual() {
    return document.documentElement.getAttribute('data-theme') ||
      (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  }
  botaoTema.addEventListener('click', () => {
    const novo = temaAtual() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', novo);
    Graficos.redesenharTodos();
  });

  // ---------- formatação ----------
  function fmtCompetencia(c) {
    if (!c || c.length !== 6) return c;
    return c.slice(0, 4) + '-' + c.slice(4, 6);
  }
  function fmtMoeda(v) {
    if (v === null || v === undefined || Number.isNaN(v)) return '—';
    return 'R$ ' + Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' mi';
  }
  function fmtPct(v) {
    if (v === null || v === undefined || Number.isNaN(v)) return '—';
    return Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 2 }) + '%';
  }
  function fmtPctFracao(v) {
    if (v === null || v === undefined || Number.isNaN(v)) return '—';
    return (v * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '%';
  }

  // ---------- índice de fundos (carregado 1x, alimenta a busca) ----------
  let indiceFundos = [];
  fetch('fundos/_indice.json')
    .then((r) => r.json())
    .then((dados) => { indiceFundos = dados; })
    .catch(() => {
      document.getElementById('conteudo-principal').innerHTML =
        '<div class="estado-vazio">Não consegui carregar o índice de fundos (fundos/_indice.json). Rode pipeline/91_gera_perfil_fundos.py.</div>';
    });

  const campoBusca = document.getElementById('busca-fundo');
  const listaSugestoes = document.getElementById('lista-sugestoes');

  function normaliza(s) {
    return (s || '').toString().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  }

  campoBusca.addEventListener('input', () => {
    const termo = normaliza(campoBusca.value.trim());
    if (!termo) { listaSugestoes.classList.remove('aberta'); listaSugestoes.innerHTML = ''; return; }
    const resultados = indiceFundos
      .filter((f) => normaliza(f.nome).includes(termo) || f.cnpj.includes(termo))
      .slice(0, 20);
    if (!resultados.length) {
      listaSugestoes.innerHTML = '<div class="sugestao">Nenhum fundo encontrado.</div>';
    } else {
      listaSugestoes.innerHTML = resultados.map((f) =>
        `<div class="sugestao" data-cnpj="${f.cnpj}"><div>${f.nome || '(sem nome)'}</div><div class="cnpj">${f.cnpj}</div></div>`
      ).join('');
    }
    listaSugestoes.classList.add('aberta');
  });

  listaSugestoes.addEventListener('click', (ev) => {
    const item = ev.target.closest('.sugestao[data-cnpj]');
    if (!item) return;
    campoBusca.value = item.querySelector('div').textContent;
    listaSugestoes.classList.remove('aberta');
    carregarFundo(item.dataset.cnpj);
  });

  document.addEventListener('click', (ev) => {
    if (!ev.target.closest('.busca-wrap')) listaSugestoes.classList.remove('aberta');
  });

  // ---------- carregamento + render de um fundo ----------
  const principal = document.getElementById('conteudo-principal');

  function carregarFundo(cnpj) {
    principal.innerHTML = '<div class="estado-vazio">Carregando…</div>';
    fetch(`fundos/${cnpj}.json`)
      .then((r) => { if (!r.ok) throw new Error('não encontrado'); return r.json(); })
      .then(renderizarFundo)
      .catch(() => {
        principal.innerHTML = '<div class="estado-vazio">Não consegui carregar o perfil desse fundo.</div>';
      });
  }

  function ultimoValor(serieObj, competencias) {
    for (let i = competencias.length - 1; i >= 0; i--) {
      const v = serieObj[competencias[i]];
      if (v !== null && v !== undefined) return v;
    }
    return null;
  }

  function renderizarFundo(p) {
    const competencias = p.competencias;
    const catMes = competencias.map(fmtCompetencia);
    const ultimaCondominio = ultimoValor(p.condominio, competencias);
    const ultimoExclusivo = ultimoValor(p.fundoExclusivo, competencias);

    const chavesSubclasse = Object.keys(p.rentabilidadePorSubclasse || {});
    const chavesElegibilidade = Object.keys(p.elegivelGeralPorSubclasse || {});
    const chavesPlClasse = Object.keys(p.plPorClasseMi || {});

    principal.innerHTML = `
      <div class="card" style="margin-bottom:16px;">
        <h2 style="margin:0 0 4px;font-size:18px;">${p.nome || '(sem nome)'}</h2>
        <div style="font-size:12px;color:var(--c-text-2);margin-bottom:14px;">CNPJ ${p.cnpj} — ${competencias.length} competência(s), ${fmtCompetencia(competencias[0])} a ${fmtCompetencia(competencias[competencias.length - 1])}</div>
        <div class="grade-info">
          <div><div class="info-rotulo">Gestora</div><div class="info-valor">${p.gestor || '—'}</div></div>
          <div><div class="info-rotulo">Administradora</div><div class="info-valor">${p.administrador || '—'}</div></div>
          <div><div class="info-rotulo">Condomínio (mês mais recente)</div><div class="info-valor">${ultimaCondominio || '—'}</div></div>
          <div><div class="info-rotulo">Fundo Exclusivo (mês mais recente)</div><div class="info-valor">
            ${ultimoExclusivo === true ? '<span class="badge badge-bad">Sim</span>' : ultimoExclusivo === false ? '<span class="badge badge-ok">Não</span>' : '<span class="badge badge-neutro">—</span>'}
          </div></div>
        </div>
      </div>

      <div class="secao-titulo">Elegibilidade por critério</div>
      <div class="card" style="margin-bottom:16px;overflow-x:auto;">
        ${Object.keys(p.elegibilidade).map((chave) => linhaElegibilidade(p.elegibilidade[chave].titulo, p.elegibilidade[chave].serie, competencias)).join('')}
        ${chavesElegibilidade.map((chave) => linhaElegibilidade('Elegibilidade Geral — ' + rotuloSubclasse(chave), p.elegivelGeralPorSubclasse[chave], competencias)).join('')}
      </div>

      <div class="secao-titulo">Rentabilidade</div>
      <div class="grade-graficos" style="margin-bottom:16px;">
        <div class="grafico-card"><div class="grafico-titulo">Rentabilidade mensal (% ao mês)</div>
          <div class="grafico-canvas-wrap"><canvas id="g-rentab-mensal"></canvas></div></div>
        <div class="grafico-card"><div class="grafico-titulo">Rentabilidade acumulada no período (%)</div>
          <div class="grafico-canvas-wrap"><canvas id="g-rentab-acumulada"></canvas></div></div>
      </div>

      <div class="secao-titulo">Patrimônio Líquido</div>
      <div class="grade-graficos" style="margin-bottom:16px;">
        <div class="grafico-card"><div class="grafico-titulo">PL por classe (R$ mi)</div>
          <div class="grafico-canvas-wrap"><canvas id="g-pl-classe"></canvas></div></div>
        <div class="grafico-card"><div class="grafico-titulo">PL total do fundo (todas as cotas somadas, R$ mi)</div>
          <div class="grafico-canvas-wrap"><canvas id="g-pl-total"></canvas></div></div>
      </div>

      <div class="secao-titulo">Direito Creditório</div>
      <div class="grade-graficos" style="margin-bottom:16px;">
        <div class="grafico-card"><div class="grafico-titulo">% do PL em carteira de direito creditório, mensal</div>
          <div class="grafico-canvas-wrap"><canvas id="g-dc-mensal"></canvas></div></div>
      </div>

      <div class="secao-titulo">Tipo de ativo</div>
      <div class="grade-graficos">
        <div class="grafico-card"><div class="grafico-titulo">PL por tipo de ativo, ao longo do tempo (R$ mi)</div>
          <div class="grafico-canvas-wrap"><canvas id="g-segmentos"></canvas></div></div>
        <div class="grafico-card">
          <div class="grafico-titulo">Composição no mês mais recente com dado (${fmtCompetencia(competenciaMaisRecenteComSegmento(p))})</div>
          <div id="tabela-segmentos-wrap" style="max-height:220px;overflow-y:auto;"></div>
        </div>
      </div>
    `;

    // ---- rentabilidade mensal / acumulada ----
    const coresSubclasse = ['--c-destaque', '--c-acento', '--c-classe-senior', '--c-classe-mezanino', '--c-classe-subordinada'];
    const seriesMensal = chavesSubclasse.map((chave, i) => ({
      label: rotuloSubclasse(chave),
      cor: Graficos.corToken(coresSubclasse[i % coresSubclasse.length]),
      pontos: competencias.map((c) => p.rentabilidadePorSubclasse[chave].mensal[c] ?? null),
    }));
    const seriesAcumulada = chavesSubclasse.map((chave, i) => ({
      label: rotuloSubclasse(chave),
      cor: Graficos.corToken(coresSubclasse[i % coresSubclasse.length]),
      pontos: competencias.map((c) => p.rentabilidadePorSubclasse[chave].acumulada[c] ?? null),
    }));
    Graficos.linha(document.getElementById('g-rentab-mensal'), { categorias: catMes, series: seriesMensal, formatoY: fmtPct });
    Graficos.linha(document.getElementById('g-rentab-acumulada'), { categorias: catMes, series: seriesAcumulada, formatoY: fmtPct });

    // ---- PL por classe / total ----
    const seriesPlClasse = chavesPlClasse.map((cnpjClasse, i) => ({
      label: cnpjClasse === p.cnpj ? 'Fundo' : cnpjClasse,
      cor: Graficos.corToken(coresSubclasse[i % coresSubclasse.length]),
      pontos: competencias.map((c) => p.plPorClasseMi[cnpjClasse][c] ?? null),
    }));
    Graficos.linha(document.getElementById('g-pl-classe'), { categorias: catMes, series: seriesPlClasse, formatoY: fmtMoeda });
    Graficos.linha(document.getElementById('g-pl-total'), {
      categorias: catMes,
      series: [{ label: 'PL total', cor: Graficos.corToken('--c-destaque'), pontos: competencias.map((c) => p.plTotalMi[c] ?? null) }],
      formatoY: fmtMoeda,
    });

    // ---- Direito Creditório mensal ----
    Graficos.linha(document.getElementById('g-dc-mensal'), {
      categorias: catMes,
      series: [{ label: '% em carteira DC', cor: Graficos.corToken('--c-destaque'), pontos: competencias.map((c) => (p.direitoCreditorioPct[c] !== null && p.direitoCreditorioPct[c] !== undefined ? p.direitoCreditorioPct[c] * 100 : null)) }],
      formatoY: fmtPct,
      dominioYFixo: [0, 100],
    });

    // ---- Tipo de ativo: top N segmentos ao longo do tempo (barra empilhada) ----
    const totalPorSegmento = {};
    competencias.forEach((c) => {
      const porSeg = p.segmentosPorMes[c] || {};
      Object.keys(porSeg).forEach((seg) => { totalPorSegmento[seg] = (totalPorSegmento[seg] || 0) + porSeg[seg].plMi; });
    });
    const TOP_N = 6;
    const segmentosOrdenados = Object.keys(totalPorSegmento).sort((a, b) => totalPorSegmento[b] - totalPorSegmento[a]);
    const topSegmentos = segmentosOrdenados.slice(0, TOP_N);
    const temOutros = segmentosOrdenados.length > TOP_N;
    const paletaSegmento = ['--c-destaque', '--c-acento', '--c-classe-senior', '--c-classe-mezanino', '--c-classe-subordinada', '--c-ok', '--c-warn'];
    const seriesSegmentos = topSegmentos.map((seg, i) => ({
      label: seg,
      cor: Graficos.corToken(paletaSegmento[i % paletaSegmento.length]),
      pontos: competencias.map((c) => (p.segmentosPorMes[c] && p.segmentosPorMes[c][seg]) ? p.segmentosPorMes[c][seg].plMi : 0),
    }));
    if (temOutros) {
      seriesSegmentos.push({
        label: 'Outros',
        cor: Graficos.corToken('--c-text-2'),
        pontos: competencias.map((c) => {
          const porSeg = p.segmentosPorMes[c] || {};
          const outros = segmentosOrdenados.slice(TOP_N).reduce((acc, seg) => acc + (porSeg[seg] ? porSeg[seg].plMi : 0), 0);
          return outros;
        }),
      });
    }
    Graficos.barrasEmpilhadas(document.getElementById('g-segmentos'), { categorias: catMes, series: seriesSegmentos, formatoY: fmtMoeda });

    // ---- tabela do mês mais recente com segmento ----
    const compRecente = competenciaMaisRecenteComSegmento(p);
    const wrap = document.getElementById('tabela-segmentos-wrap');
    if (compRecente && p.segmentosPorMes[compRecente]) {
      const linhas = Object.entries(p.segmentosPorMes[compRecente]).sort((a, b) => b[1].plMi - a[1].plMi);
      wrap.innerHTML = `<table class="tabela-segmentos"><thead><tr><th>Tipo de ativo</th><th>PL</th><th>%</th></tr></thead><tbody>` +
        linhas.map(([seg, v]) => `<tr><td>${seg}</td><td>${fmtMoeda(v.plMi)}</td><td>${fmtPctFracao(v.pct)}</td></tr>`).join('') +
        `</tbody></table>`;
    } else {
      wrap.innerHTML = '<div class="estado-vazio">Sem dado de composição de carteira.</div>';
    }

    [
      'g-rentab-mensal', 'g-rentab-acumulada', 'g-pl-classe', 'g-pl-total', 'g-dc-mensal', 'g-segmentos',
    ].forEach((id) => Graficos.observarRedesenho(document.getElementById(id)));
  }

  function rotuloSubclasse(chave) {
    const partes = chave.split('|');
    const classe = partes[2] || '';
    const serie = partes[1] || '';
    return (classe ? classe + ' — ' : '') + serie;
  }

  function competenciaMaisRecenteComSegmento(p) {
    for (let i = p.competencias.length - 1; i >= 0; i--) {
      const c = p.competencias[i];
      if (p.segmentosPorMes[c] && Object.keys(p.segmentosPorMes[c]).length) return c;
    }
    return null;
  }

  function linhaElegibilidade(rotulo, serie, competencias) {
    const celulas = competencias.map((c) => {
      const v = serie[c];
      const classe = v === true ? 'celula-ok' : v === false ? 'celula-bad' : 'celula-vazia';
      const titulo = v === true ? 'Elegível' : v === false ? 'Não elegível' : 'Sem dado';
      return `<div class="celula-mes ${classe}" title="${c}: ${titulo}"></div>`;
    }).join('');
    return `<div class="linha-elegibilidade"><div class="rotulo">${rotulo}</div><div class="tira-meses">${celulas}</div></div>`;
  }
})();
