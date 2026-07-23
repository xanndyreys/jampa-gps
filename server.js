const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname)));
app.use(express.json());

let estadoAtual = {
    bairro: "Tambaú",
    temperatura: "29°C"
};

let ultimoBairroEnviado = "";

// Função inteligente expandida para cobrir João Pessoa, Cabedelo, Conde e região
function identificarBairroPorGPS(lat, lon) {
    // 1. Cabedelo (Praia do Jacaré, Intermares, Poço, Camboinha)
    if (lat > -7.0850) {
        return "Cabedelo (Intermares/Poço)";
    } 
    // 2. Limite entre Cabedelo e João Pessoa (Manaíra / Bessa)
    else if (lat >= -7.1150 && lat <= -7.0850) {
        return "Manaíra / Bessa";
    } 
    // 3. João Pessoa (Tambaú / Cabo Branco / Seixas)
    else if (lat > -7.1500 && lat < -7.1150) {
        return "Tambaú / Cabo Branco";
    } 
    // 4. Região Sul / Próximo ao Conde (Praias do Sul: Coqueirinho, Jacumã, Tabatinga)
    else if (lat <= -7.1500 && lat >= -7.2500) {
        return "Conde (Litoral Sul)";
    } 
    // 5. Bayeux ou interior metropolitano
    else {
        return "Região Metropolitana";
    }
}

// Rota que recebe os dados do celular na rua
app.post('/api/atualizar', (req, res) => {
    const { lat, lon, temperatura } = req.body;
    
    if (lat !== undefined && lon !== undefined) {
        const bairroDetectado = identificarBairroPorGPS(lat, lon);
        
        if (temperatura) {
            estadoAtual.temperatura = temperatura;
        }

        // REGRA DE OURO: Se mudou de região/bairro, dispara imediatamente para o OBS
        if (bairroDetectado !== ultimoBairroEnviado) {
            estadoAtual.bairro = bairroDetectado;
            ultimoBairroEnviado = bairroDetectado;

            broadcast({
                tipo: "MUDANCA_IMEDIATA",
                bairro: estadoAtual.bairro,
                temperatura: estadoAtual.temperatura,
                duracao: 180000 // 3 minutos visível na tela
            });

            console.log(`Mudança de Região detectada: ${bairroDetectado}`);
        }

        return res.json({ status: "sucesso", bairro: estadoAtual.bairro, temperatura: estadoAtual.temperatura });
    }
    
    res.status(400).json({ status: "erro", mensagem: "Coordenadas inválidas" });
});

function broadcast(data) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data));
        }
    });
}

// Ciclo automático padrão (3 min visível, 7 min oculto)
const TEMPO_NA_TELA = 3 * 60 * 1000;
const INTERVALO_CICLO = 10 * 60 * 1000;

setInterval(() => {
    broadcast({
        tipo: "MOSTRAR",
        bairro: estadoAtual.bairro,
        temperatura: estadoAtual.temperatura,
        duracao: TEMPO_NA_TELA
    });
}, INTERVALO_CICLO);

wss.on('connection', (ws) => {
    console.log('OBS conectado ao sistema!');
    ws.send(JSON.stringify({
        tipo: "STATUS",
        bairro: estadoAtual.bairro,
        temperatura: estadoAtual.temperatura,
        duracao: TEMPO_NA_TELA
    }));
});

const PORT = process.env.PORT || 3939;
server.listen(PORT, () => {
    console.log(`Servidor de geolocalização rodando na porta ${PORT}`);
});

