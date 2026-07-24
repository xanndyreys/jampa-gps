 from pathlib import Path
import re

src = Path("/mnt/data/server(2).js")
dst = Path("/mnt/data/server_jampa_v2.js")

text = src.read_text(encoding="utf-8")

text = text.replace(
"""const INTERVALO_VERIFICACAO = 1_000;
const INTERVALO_HEARTBEAT = 30_000;
""",
"""const INTERVALO_VERIFICACAO = 1_000;
const INTERVALO_HEARTBEAT = 30_000;
const TEMPO_CACHE_GEOCODIFICACAO = 30_000;
const DISTANCIA_CACHE_METROS = 80;
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/reverse';
"""
)

text = text.replace(
"""let ultimaLeituraDoCelular = 0;
let telaVisivelNoObs = false;
let temporizadorExibicao = null;
""",
"""let ultimaLeituraDoCelular = 0;
let telaVisivelNoObs = false;
let temporizadorExibicao = null;

let cacheGeocodificacao = {
    lat: null,
    lon: null,
    bairro: '',
    cidade: '',
    timestamp: 0
};
"""
)

pattern_func = re.compile(
    r"function identificarBairroPorGPS\(lat, lon\) \{.*?\n\}\n\nfunction obterValor",
    re.S
)

replacement_func = """function calcularDistanciaMetros(lat1, lon1, lat2, lon2) {
    const raioTerra = 6_371_000;
    const converterParaRadianos = graus => graus * Math.PI / 180;

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

function selecionarBairro(address = {}) {
    return (
        address.suburb ||
        address.neighbourhood ||
        address.quarter ||
        address.city_district ||
        address.residential ||
        ''
    );
}

function selecionarCidade(address = {}) {
    return (
        address.city ||
        address.town ||
        address.village ||
        address.municipality ||
        address.county ||
        ''
    );
}

function cacheGeocodificacaoValido(lat, lon) {
    if (
        !Number.isFinite(cacheGeocodificacao.lat) ||
        !Number.isFinite(cacheGeocodificacao.lon) ||
        !cacheGeocodificacao.bairro
    ) {
        return false;
    }

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

async function identificarLocalPorGPS(lat, lon) {
    if (cacheGeocodificacaoValido(lat, lon)) {
        return {
            bairro: cacheGeocodificacao.bairro,
            cidade: cacheGeocodificacao.cidade
        };
    }

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

function obterValor"""

text, n1 = pattern_func.subn(replacement_func, text, count=1)
if n1 != 1:
    raise RuntimeError("Falha ao substituir a função de localização.")

pattern_route = re.compile(
    r"app\.all\('/api/atualizar', \(req, res\) => \{.*?\n\}\);\n\nsetInterval",
    re.S
)

replacement_route = """app.all('/api/atualizar', async (req, res) => {
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

setInterval"""

text, n2 = pattern_route.subn(replacement_route, text, count=1)
if n2 != 1:
    raise RuntimeError("Falha ao substituir a rota /api/atualizar.")

dst.write_text(text, encoding="utf-8")
print(f"Arquivo criado: {dst}")
