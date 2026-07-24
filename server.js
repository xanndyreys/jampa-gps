'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3939;
const ATRASO_PARA_EXIBIR = 15_000;
const LIMITE_SEM_SINAL = 60_000;
const INTERVALO_VERIFICACAO = 1_000;
const INTERVALO_HEARTBEAT = 30_000;

app.disable('x-powered-by');
app.use(express.json({ limit: '20kb' }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname), {
    etag: false,
    lastModified: false,
    setHeaders(res) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
    }
}));

let estadoAtual = {
    bairro: '',
    temperatura: ''
};

let ultimaLeituraDoCelular = 0;
let telaVisivelNoObs = false;
let temporizadorExibicao = null;

function identificarBairroPorGPS(lat, lon) {
    // Classificação provisória por regiões. A longitude será usada na etapa
    // futura de polígonos geográficos para bairros exatos.
    void lon;

    if (lat > -7.0850) {
        return 'Cabedelo (Intermares/Poço)';
    }

    if (lat >= -7.1150) {
        return 'Manaíra / Bessa';
    }

    if (lat > -7.1500) {
        return 'Tambaú / Cabo Branco';
    }

    if (lat >= -7.2500) {
        return 'Conde (Litoral Sul)';
    }

    return 'Região Metropolitana';
}

function obterValor(req, nome) {
    if (req.body && req.body[nome] !== undefined) {
        return req.body[nome];
    }

    if (req.query && req.query[nome] !== undefined) {
        return req.query[nome];
    }

    return undefined;
}

function enviar(client, dados) {
    if (client.readyState !== WebSocket.OPEN) {
        return;
    }

    try {
        client.send(JSON.stringify(dados));
    } catch (erro) {
        console.error('[WebSocket] Falha no envio:', erro.message);
    }
}

function broadcast(dados) {
    for (const client of wss.clients) {
        enviar(client, dados);
    }
}

function cancelarTemporizadorExibicao() {
    if (temporizadorExibicao) {
        clearTimeout(temporizadorExibicao);
        temporizadorExibicao = null;
    }
}

function limparTela(motivo) {
    cancelarTemporizadorExibicao();

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

function iniciarAtrasoDeExibicao() {
    cancelarTemporizadorExibicao();

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

app.get('/health', (req, res) => {
    res.json({
        status: 'online',
        obsConectados: [...wss.clients].filter(
            client => client.readyState === WebSocket.OPEN
        ).length,
        celularAtivo:
            ultimaLeituraDoCelular > 0 &&
            Date.now() - ultimaLeituraDoCelular <= LIMITE_SEM_SINAL,
        telaVisivelNoObs,
        bairro: telaVisivelNoObs ? estadoAtual.bairro : '',
        temperatura: telaVisivelNoObs ? estadoAtual.temperatura : ''
    });
});

app.all('/api/atualizar', (req, res) => {
    const lat = Number.parseFloat(obterValor(req, 'lat'));
    const lon = Number.parseFloat(obterValor(req, 'lon'));
    const temperaturaRecebida = obterValor(req, 'temperatura');

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
    estadoAtual.bairro = identificarBairroPorGPS(lat, lon);

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

setInterval(() => {
    if (ultimaLeituraDoCelular === 0) {
        return;
    }

    if (Date.now() - ultimaLeituraDoCelular > LIMITE_SEM_SINAL) {
        limparTela('mais de 60 segundos sem sinal do celular');
    }
}, INTERVALO_VERIFICACAO);

wss.on('connection', (ws) => {
    console.log('[WebSocket] OBS conectado.');
    ws.isAlive = true;

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

const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
        if (ws.isAlive === false) {
            console.log('[WebSocket] Conexão sem resposta encerrada.');
            ws.terminate();
            continue;
        }

        ws.isAlive = false;
        ws.ping();
    }
}, INTERVALO_HEARTBEAT);

wss.on('close', () => {
    clearInterval(heartbeat);
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`[Servidor] Jampa GPS rodando na porta ${PORT}.`);
});
