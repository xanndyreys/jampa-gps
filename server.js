 ‘use strict’;

const express = require(‘express’); const http = require(‘http’); const
path = require(‘path’); const WebSocket = require(‘ws’);

const app = express(); const server = http.createServer(app); const wss
= new WebSocket.Server({ server });

const PORT = process.env.PORT || 3939; const ATRASO_PARA_EXIBIR =
15_000; const LIMITE_SEM_SINAL = 60_000; const INTERVALO_VERIFICACAO =
1_000; const INTERVALO_HEARTBEAT = 30_000; const
TEMPO_CACHE_GEOCODIFICACAO = 30_000; const DISTANCIA_CACHE_METROS = 80;
const NOMINATIM_URL = ‘https://nominatim.openstreetmap.org/reverse’;

app.disable(‘x-powered-by’); app.use(express.json({ limit: ‘20kb’ }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname), { etag: false,
lastModified: false, setHeaders(res) { res.setHeader(‘Cache-Control’,
‘no-store, no-cache, must-revalidate, proxy-revalidate’);
res.setHeader(‘Pragma’, ‘no-cache’); res.setHeader(‘Expires’, ‘0’); }
}));

let estadoAtual = { bairro: ’‘, temperatura:’’ };

let ultimaLeituraDoCelular = 0; let telaVisivelNoObs = false; let
temporizadorExibicao = null;

let cacheGeocodificacao = { lat: null, lon: null, bairro: ’‘, cidade:’’,
timestamp: 0 };

function calcularDistanciaMetros(lat1, lon1, lat2, lon2) { const
raioTerra = 6_371_000; const converterParaRadianos = graus => graus *
Math.PI / 180;

    const deltaLat = converterParaRadianos(lat2 - lat1);
    const deltaLon = converterParaRadianos(lon2 - lon1);

    const a =
        Math.sin(deltaLat / 2) ** 2 +
        Math.cos(converterParaRadianos(lat1)) *
        Math.cos(converterParaRadianos(lat2)) *
        Math.sin(deltaLon / 2) ** 2;

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return raioTerra * c;

}

function selecionarBairro(address = {}) { return ( address.suburb ||
address.neighbourhood || address.quarter || address.city_district ||
address.residential || ’’ ); }

function selecionarCidade(address = {}) { return ( address.city ||
address.town || address.village || address.municipality ||
address.county || ’’ ); }

function cacheGeocodificacaoValido(lat, lon) { if (
!Number.isFinite(cacheGeocodificacao.lat) ||
!Number.isFinite(cacheGeocodificacao.lon) || !cacheGeocodificacao.bairro
) { return false; }

    const cacheAindaRecente =
        Date.now() - cacheGeocodificacao.timestamp <= TEMPO_CACHE_GEOCODIFICACAO;

    if (!cacheAindaRecente) {
        return false;
    }

    const distancia = calcularDistanciaMetros(
        cacheGeocodificacao.lat,
        cacheGeocodificacao.lon,
        lat,
        lon
    );

    return distancia <= DISTANCIA_CACHE_METROS;

}

async function identificarLocalPorGPS(lat, lon) { if
(cacheGeocodificacaoValido(lat, lon)) { return { bairro:
cacheGeocodificacao.bairro, cidade: cacheGeocodificacao.cidade }; }

    const url = new URL(NOMINATIM_URL);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('lat', String(lat));
    url.searchParams.set('lon', String(lon));
    url.searchParams.set('zoom', '18');
    url.searchParams.set('addressdetails', '1');
    url.searchParams.set('accept-language', 'pt-BR');

    const resposta = await fetch(url, {
        headers: {
            'User-Agent': 'JampaGPS/2.0 (overlay de localização para transmissão)',
            'Accept': 'application/json'
        },
        signal: AbortSignal.timeout(10_000)
    });

    if (!resposta.ok) {
        throw new Error(`Nominatim respondeu com status ${resposta.status}`);
    }

    const dados = await resposta.json();
    const address = dados && dados.address ? dados.address : {};

    const cidade = selecionarCidade(address);
    const bairroEncontrado = selecionarBairro(address);
    const bairro = bairroEncontrado || cidade || 'Localização indisponível';

    cacheGeocodificacao = {
        lat,
        lon,
        bairro,
        cidade,
        timestamp: Date.now()
    };

    return { bairro, cidade };

}

function obterValor(req, nome) { if (req.body && req.body[nome] !==
undefined) { return req.body[nome]; }

    if (req.query && req.query[nome] !== undefined) {
        return req.query[nome];
    }

    return undefined;

}

function enviar(client, dados) { if (client.readyState !==
WebSocket.OPEN) { return; }

    try {
        client.send(JSON.stringify(dados));
    } catch (erro) {
        console.error('[WebSocket] Falha no envio:', erro.message);
    }

}

function broadcast(dados) { for (const client of wss.clients) {
enviar(client, dados); } }

function cancelarTemporizadorExibicao() { if (temporizadorExibicao) {
clearTimeout(temporizadorExibicao); temporizadorExibicao = null; } }

function limparTela(motivo) { cancelarTemporizadorExibicao();

    telaVisivelNoObs = false;
    ultimaLeituraDoCelular = 0;
    estadoAtual = {
        bairro: '',
        temperatura: ''
    };

    broadcast({
        tipo: 'LIMPAR_TELA',
        bairro: '',
        temperatura: ''
    });

    console.log(`[Servidor] Tela limpa: ${motivo}.`);

}

function iniciarAtrasoDeExibicao() { cancelarTemporizadorExibicao();

    console.log('[Celular] Primeiro sinal válido. Aguardando exatamente 15 segundos.');

    temporizadorExibicao = setTimeout(() => {
        temporizadorExibicao = null;

        // Aos 15 segundos, o sinal ainda está necessariamente dentro do limite
        // de 60 segundos. Mesmo assim, a validação protege contra relógio alterado.
        const sinalAindaValido =
            ultimaLeituraDoCelular > 0 &&
            Date.now() - ultimaLeituraDoCelular <= LIMITE_SEM_SINAL;

        if (!sinalAindaValido || !estadoAtual.bairro) {
            limparTela('sinal inválido durante a estabilização');
            return;
        }

        telaVisivelNoObs = true;

        broadcast({
            tipo: 'MOSTRAR',
            bairro: estadoAtual.bairro,
            temperatura: estadoAtual.temperatura
        });

        console.log(
            `[Servidor] MOSTRAR após 15 segundos: ${estadoAtual.bairro} | ${estadoAtual.temperatura}`
        );
    }, ATRASO_PARA_EXIBIR);

}

app.get(‘/health’, (req, res) => { res.json({ status: ‘online’,
obsConectados: […wss.clients].filter( client => client.readyState ===
WebSocket.OPEN ).length, celularAtivo: ultimaLeituraDoCelular > 0 &&
Date.now() - ultimaLeituraDoCelular <= LIMITE_SEM_SINAL,
telaVisivelNoObs, bairro: telaVisivelNoObs ? estadoAtual.bairro : ’‘,
temperatura: telaVisivelNoObs ? estadoAtual.temperatura :’’ }); });

app.all(‘/api/atualizar’, async (req, res) => { const lat =
Number.parseFloat(obterValor(req, ‘lat’)); const lon =
Number.parseFloat(obterValor(req, ‘lon’)); const temperaturaRecebida =
obterValor(req, ‘temperatura’);

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        console.log('[Celular] Requisição rejeitada: coordenadas ausentes ou inválidas.');
        return res.status(400).json({
            status: 'erro',
            mensagem: 'Coordenadas inválidas'
        });
    }

    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
        console.log('[Celular] Requisição rejeitada: coordenadas fora dos limites.');
        return res.status(400).json({
            status: 'erro',
            mensagem: 'Coordenadas fora dos limites permitidos'
        });
    }

    const agora = Date.now();
    const estavaInativo =
        ultimaLeituraDoCelular === 0 ||
        agora - ultimaLeituraDoCelular > LIMITE_SEM_SINAL;

    ultimaLeituraDoCelular = agora;

    try {
        const local = await identificarLocalPorGPS(lat, lon);
        estadoAtual.bairro = local.bairro;
    } catch (erro) {
        console.error('[Geocodificação] Falha:', erro.message);

        if (!estadoAtual.bairro) {
            estadoAtual.bairro = 'João Pessoa';
        }
    }

    if (temperaturaRecebida !== undefined && temperaturaRecebida !== null) {
        estadoAtual.temperatura = String(temperaturaRecebida).trim();
    }

    console.log(
        `[Celular] Sinal recebido: lat=${lat}, lon=${lon}, bairro=${estadoAtual.bairro}, temp=${estadoAtual.temperatura}`
    );

    if (estavaInativo) {
        telaVisivelNoObs = false;
        iniciarAtrasoDeExibicao();
    } else if (telaVisivelNoObs) {
        broadcast({
            tipo: 'ATUALIZAR',
            bairro: estadoAtual.bairro,
            temperatura: estadoAtual.temperatura
        });
    }

    return res.json({
        status: 'sucesso',
        bairro: estadoAtual.bairro,
        temperatura: estadoAtual.temperatura,
        telaVisivel: telaVisivelNoObs
    });

});

setInterval(() => { if (ultimaLeituraDoCelular === 0) { return; }

    if (Date.now() - ultimaLeituraDoCelular > LIMITE_SEM_SINAL) {
        limparTela('mais de 60 segundos sem sinal do celular');
    }

}, INTERVALO_VERIFICACAO);

wss.on(‘connection’, (ws) => { console.log(‘[WebSocket] OBS
conectado.’); ws.isAlive = true;

    ws.on('pong', () => {
        ws.isAlive = true;
    });

    ws.on('message', mensagem => {
        ws.isAlive = true;

        if (mensagem.toString() === 'PING') {
            enviar(ws, {
                tipo: 'PONG',
                timestamp: Date.now()
            });
        }
    });

    ws.on('close', () => {
        console.log('[WebSocket] OBS desconectado.');
    });

    ws.on('error', erro => {
        console.error('[WebSocket] Erro:', erro.message);
    });

    enviar(ws, {
        tipo: 'STATUS',
        bairro: telaVisivelNoObs ? estadoAtual.bairro : '',
        temperatura: telaVisivelNoObs ? estadoAtual.temperatura : ''
    });

});

const heartbeat = setInterval(() => { for (const ws of wss.clients) { if
(ws.isAlive === false) { console.log(‘[WebSocket] Conexão sem resposta
encerrada.’); ws.terminate(); continue; }

        ws.isAlive = false;
        ws.ping();
    }

}, INTERVALO_HEARTBEAT);

wss.on(‘close’, () => { clearInterval(heartbeat); });

server.listen(PORT, ‘0.0.0.0’, () => {
console.log([Servidor] Jampa GPS rodando na porta ${PORT}.); });
