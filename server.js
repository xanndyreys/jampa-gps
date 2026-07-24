 'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';
const NOMINATIM_USER_AGENT =
  process.env.NOMINATIM_USER_AGENT ||
  'JampaNaOrla2-GPS/2.2 (contato: canal Jampa na Orla 2)';

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json({ limit: '20kb' }));
app.use(express.urlencoded({ extended: false, limit: '20kb' }));
app.use(express.static(__dirname));

let ultimoPacote = null;
let cacheBairro = {
  latitude: null,
  longitude: null,
  bairro: null,
  timestamp: 0,
};
let cacheTemperatura = {
  latitude: null,
  longitude: null,
  temperatura: null,
  timestamp: 0,
};

const CACHE_BAIRRO_MS = 10 * 60_000;
const CACHE_TEMPERATURA_MS = 10 * 60_000;
const DISTANCIA_CACHE_BAIRRO_METROS = 80;
const DISTANCIA_CACHE_TEMPERATURA_METROS = 2_000;

function enviarJson(res, status, payload) {
  res.status(status).json(payload);
}

function numeroValido(valor, minimo, maximo) {
  const numero = Number(valor);
  return Number.isFinite(numero) && numero >= minimo && numero <= maximo
    ? numero
    : null;
}

function distanciaEmMetros(lat1, lon1, lat2, lon2) {
  const raioTerra = 6_371_000;
  const rad = (graus) => (graus * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return raioTerra * c;
}

function limparNomeLocal(valor) {
  if (typeof valor !== 'string') return null;

  const limpo = valor
    .replace(/\s*\/\s*.*/u, '')
    .replace(/\s*,\s*.*/u, '')
    .replace(/^bairro\s+/iu, '')
    .trim();

  return limpo || null;
}

function escolherBairro(address = {}) {
  const candidatos = [
    address.neighbourhood,
    address.suburb,
    address.quarter,
    address.residential,
    address.city_district,
    address.hamlet,
    address.village,
    address.town,
    address.city,
  ];

  for (const candidato of candidatos) {
    const bairro = limparNomeLocal(candidato);
    if (bairro) return bairro;
  }

  return 'Localização atual';
}

async function buscarBairro(latitude, longitude) {
  const url = new URL('https://nominatim.openstreetmap.org/reverse');
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('lat', latitude.toFixed(7));
  url.searchParams.set('lon', longitude.toFixed(7));
  url.searchParams.set('zoom', '18');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('accept-language', 'pt-BR');

  const resposta = await fetch(url, {
    headers: {
      'User-Agent': NOMINATIM_USER_AGENT,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!resposta.ok) {
    throw new Error(`Nominatim respondeu HTTP ${resposta.status}`);
  }

  const dados = await resposta.json();
  return escolherBairro(dados.address);
}

async function buscarTemperatura(latitude, longitude) {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', latitude.toFixed(7));
  url.searchParams.set('longitude', longitude.toFixed(7));
  url.searchParams.set('current', 'temperature_2m');
  url.searchParams.set('timezone', 'America/Fortaleza');
  url.searchParams.set('forecast_days', '1');

  const resposta = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });

  if (!resposta.ok) {
    throw new Error(`Open-Meteo respondeu HTTP ${resposta.status}`);
  }

  const dados = await resposta.json();
  const temperatura = Number(dados?.current?.temperature_2m);
  return Number.isFinite(temperatura) ? Math.round(temperatura) : null;
}

function transmitir(payload) {
  const mensagem = JSON.stringify(payload);

  for (const cliente of wss.clients) {
    if (cliente.readyState === WebSocket.OPEN) {
      cliente.send(mensagem);
    }
  }
}

async function obterDadosLocalizacao(latitude, longitude) {
  const agora = Date.now();

  const bairroPerto =
    Number.isFinite(cacheBairro.latitude) &&
    Number.isFinite(cacheBairro.longitude) &&
    distanciaEmMetros(
      cacheBairro.latitude,
      cacheBairro.longitude,
      latitude,
      longitude,
    ) <= DISTANCIA_CACHE_BAIRRO_METROS;

  const temperaturaPerto =
    Number.isFinite(cacheTemperatura.latitude) &&
    Number.isFinite(cacheTemperatura.longitude) &&
    distanciaEmMetros(
      cacheTemperatura.latitude,
      cacheTemperatura.longitude,
      latitude,
      longitude,
    ) <= DISTANCIA_CACHE_TEMPERATURA_METROS;

  const usarBairroCache =
    bairroPerto && agora - cacheBairro.timestamp < CACHE_BAIRRO_MS;
  const usarTemperaturaCache =
    temperaturaPerto &&
    agora - cacheTemperatura.timestamp < CACHE_TEMPERATURA_MS;

  const bairroPromessa = usarBairroCache
    ? Promise.resolve(cacheBairro.bairro)
    : buscarBairro(latitude, longitude);

  const temperaturaPromessa = usarTemperaturaCache
    ? Promise.resolve(cacheTemperatura.temperatura)
    : buscarTemperatura(latitude, longitude);

  const [bairroResultado, temperaturaResultado] = await Promise.allSettled([
    bairroPromessa,
    temperaturaPromessa,
  ]);

  const bairro =
    bairroResultado.status === 'fulfilled'
      ? bairroResultado.value
      : cacheBairro.bairro || 'Localização atual';

  const temperatura =
    temperaturaResultado.status === 'fulfilled'
      ? temperaturaResultado.value
      : Number.isFinite(cacheTemperatura.temperatura)
        ? cacheTemperatura.temperatura
        : null;

  if (!usarBairroCache && bairroResultado.status === 'fulfilled') {
    cacheBairro = { latitude, longitude, bairro, timestamp: agora };
  }

  if (!usarTemperaturaCache && temperaturaResultado.status === 'fulfilled') {
    cacheTemperatura = { latitude, longitude, temperatura, timestamp: agora };
  }

  if (bairroResultado.status === 'rejected') {
    console.error(
      '[Nominatim]',
      bairroResultado.reason?.message || bairroResultado.reason,
    );
  }

  if (temperaturaResultado.status === 'rejected') {
    console.error(
      '[Open-Meteo]',
      temperaturaResultado.reason?.message || temperaturaResultado.reason,
    );

    cacheTemperatura.timestamp = agora;
    cacheTemperatura.latitude = latitude;
    cacheTemperatura.longitude = longitude;
  }

  return { bairro, temperatura };
}

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/controle', (_req, res) => {
  res.sendFile(path.join(__dirname, 'controle.html'));
});

app.get('/status', (_req, res) => {
  enviarJson(res, 200, {
    status: 'online',
    versao: '2.2',
    websocketClientes: wss.clients.size,
    ultimoPacote,
  });
});

app.post(['/gps', '/api/gps', '/localizacao'], async (req, res) => {
  const latitude = numeroValido(req.body?.latitude ?? req.body?.lat, -90, 90);
  const longitude = numeroValido(
    req.body?.longitude ?? req.body?.lon ?? req.body?.lng,
    -180,
    180,
  );

  if (latitude === null || longitude === null) {
    return enviarJson(res, 400, {
      status: 'erro',
      mensagem: 'Latitude ou longitude inválida.',
    });
  }

  try {
    const { bairro, temperatura } = await obterDadosLocalizacao(
      latitude,
      longitude,
    );

    ultimoPacote = {
      tipo: 'localizacao',
      bairro,
      temperatura,
      latitude,
      longitude,
      recebidoEm: new Date().toISOString(),
    };

    transmitir(ultimoPacote);

    return enviarJson(res, 200, {
      status: 'sucesso',
      bairro,
      temperatura,
    });
  } catch (erro) {
    console.error('[GPS]', erro);
    return enviarJson(res, 500, {
      status: 'erro',
      mensagem: 'Não foi possível processar a localização.',
    });
  }
});

app.post('/parar', (_req, res) => {
  ultimoPacote = null;
  transmitir({ tipo: 'ocultar', recebidoEm: new Date().toISOString() });
  enviarJson(res, 200, { status: 'sucesso' });
});

wss.on('connection', (socket) => {
  console.log('[WebSocket] Cliente conectado. Total:', wss.clients.size);

  socket.send(
    JSON.stringify({
      tipo: 'conexao',
      status: 'conectado',
      servidorEm: new Date().toISOString(),
    }),
  );

  if (ultimoPacote) {
    socket.send(JSON.stringify(ultimoPacote));
  }

  socket.on('close', () => {
    console.log('[WebSocket] Cliente desconectado. Total:', wss.clients.size);
  });

  socket.on('error', (erro) => {
    console.error('[WebSocket]', erro.message);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Jampa GPS 2.2 online na porta ${PORT}`);
});
