"""Planejador de maratona escalável para relógios Garmin.

Calcula parciais, zona de pace e a configuração de tela do modelo escolhido.
Novos relógios entram em LINE_PROFILES ou MODEL_OVERRIDES. Novas metas entram
por argumento ou por JSON. A fisiologia fica em PLANO_MARATONA_GARMIN.md.

Entrada opcional (--config), chaves planas:

    {
      "model": "Forerunner 165",
      "distance_km": 42.195,
      "pace": "06:40",
      "race_date": "2026-11-01",
      "tolerance_seconds": 10,
      "split_km": 5,
      "event_name": "Maratona Maurício de Nassau",
      "event_city": "Recife"
    }

O JSON exportado também pode ser recarregado com --config.
"""

from __future__ import annotations

import argparse
import json
import re
import struct
import sys
import unicodedata
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from pathlib import Path


PLANNER_VERSION = "1.2.0"
DEFAULT_OUTPUT = Path(__file__).resolve().parent / "treino_maratona_config.json"
DEFAULT_FIT_OUTPUT = Path(__file__).resolve().parent / "treino_ritmo_maratona.fit"
DEFAULT_BLOCK_KM = "10"
WARMUP_SECONDS = 15 * 60
COOLDOWN_SECONDS = 10 * 60

DEFAULTS: dict[str, object] = {
    "model": "Forerunner 165",
    "distance_km": "42.195",
    "pace": "06:40",
    "race_date": "2026-11-01",
    "tolerance_seconds": 10,
    "split_km": "5",
    "event_name": "Maratona Maurício de Nassau",
    "event_city": "Recife",
    "current_long_km": "",
    "plan_start": "",
}

ALLOWED_KEYS = set(DEFAULTS)

ALIASES = {
    "fr165": "forerunner 165",
    "fr 165": "forerunner 165",
    "forerunner165": "forerunner 165",
}


@dataclass(frozen=True)
class LineProfile:
    line: str
    input_style: str
    navigation: str
    metrics: str
    battery: str
    setup_steps: tuple[str, ...]
    screen_recommendations: tuple[str, ...]
    run_workout_path: str
    strength_workout_path: str
    pacepro_path: str
    course_path: str


@dataclass(frozen=True)
class ModelOverride:
    notes: tuple[str, ...]
    extra_screens: tuple[str, ...] = ()
    metrics: str = ""
    battery: str = ""


@dataclass(frozen=True)
class ResolvedWatch:
    model: str
    line: str
    cataloged_line: bool
    exact_model: bool
    input_style: str
    navigation: str
    metrics: str
    battery: str
    setup_steps: tuple[str, ...]
    screen_recommendations: tuple[str, ...]
    model_notes: tuple[str, ...]
    run_workout_path: str
    strength_workout_path: str
    pacepro_path: str
    course_path: str


@dataclass(frozen=True)
class AppConfig:
    model: str
    distance_km: object
    pace: str
    race_date: str
    tolerance_seconds: object
    split_km: object
    event_name: str
    event_city: str
    output: Path
    fit_output: Path | None
    block_km: object
    trainings_dir: Path | None
    finish_time: str | None = None
    json_only: bool = False
    current_long_km: object = ""
    plan_start: str = ""
    workout_kind: str | None = None
    workout: dict[str, object] | None = None
    workout_output: Path | None = None


@dataclass(frozen=True)
class Split:
    mark_km: Decimal
    segment_km: Decimal
    segment_seconds: int
    cumulative_seconds: int
    pace_seconds: int


@dataclass(frozen=True)
class PaceZone:
    tolerance_seconds: int
    faster_seconds: int
    target_seconds: int
    slower_seconds: int

    @property
    def faster_pace(self) -> str:
        return format_pace(self.faster_seconds)

    @property
    def target_pace(self) -> str:
        return format_pace(self.target_seconds)

    @property
    def slower_pace(self) -> str:
        return format_pace(self.slower_seconds)


LINE_PROFILES: dict[str, LineProfile] = {
    "forerunner": LineProfile(
        line="Forerunner",
        input_style=(
            "Cinco botões (LIGHT, UP, DOWN, START/STOP, BACK) e toque. "
            "Durante a atividade, BACK marca a volta e avança a etapa do treino. "
            "UP e DOWN trocam as telas. Com suor, use os botões."
        ),
        navigation=(
            "165 e 265 seguem o traçado do curso e o TracBack. "
            "A 965 traz mapa topográfico embarcado, ClimbPro e Stamina."
        ),
        metrics=(
            "165: HRV Status, Body Battery, sono, VO2, tempo de recuperação, "
            "Training Effect e PacePro. Da 265 em diante: Training Status e "
            "Training Readiness. 965: Stamina, Endurance Score e Hill Score."
        ),
        battery=(
            "Os Forerunner atuais passam de 18 h em GPS apenas. Numa maratona de até 5 h, "
            "GPS apenas e música desligada sobram; multibanda e música encurtam a autonomia."
        ),
        setup_steps=(
            "Envie o treino pelo Garmin Connect e espere o sincronismo terminar.",
            "Para iniciar o treino: START, Corrida, UP, Treino, Treinos, escolha o treino, START, Fazer treino, START.",
            "Volta automática: segure UP, Atividades e aplicativos, Corrida, Voltas, Auto Lap, Por distância, 1,00 km.",
            "Alerta de faixa: configurações da Corrida, Alertas, ritmo, com os limites rápido e lento da zona.",
            "Telas de dados: segure UP, Atividades e aplicativos, Corrida, Telas de dados. Deixe a primeira tela curta.",
        ),
        screen_recommendations=(
            "Tela 1: ritmo atual, ritmo da volta, distância, frequência cardíaca e cronômetro.",
            "Tela 2: ritmo médio da prova e hora do dia.",
            "Auto Lap de 1,00 km. Os acumulados de 5 km do plano servem de conferência, não de volta do relógio.",
            "Fora da prova, mantenha no loop de visões: HRV Status, Body Battery, sono e tempo de recuperação.",
        ),
        run_workout_path="START → Corrida → UP → Treino → Treinos → treino do dia",
        strength_workout_path="START → Força → Treinos → treino do dia",
        pacepro_path="START → Corrida → segure UP → Treino → Planos PacePro → Aceitar plano → START",
        course_path="START → Corrida → segure UP → Navegação → Percursos → Fazer percurso",
    ),
    "venu": LineProfile(
        line="Venu",
        input_style=(
            "Tela de toque AMOLED. O botão Action abre as atividades. "
            "Durante a atividade, o botão Back marca a volta e avança a etapa. "
            "A troca de tela é por deslize."
        ),
        navigation=(
            "Curso e calendário de treino. Sem mapa topográfico de trilha "
            "e sem ClimbPro no padrão da linha Fenix."
        ),
        metrics=(
            "Venu 3: HRV Status, Body Battery, sono, Sleep Coach e Training Status. "
            "Stamina em tempo real e ClimbPro ficam na linha Fenix/Epix e na Forerunner 965."
        ),
        battery=(
            "Chegue com carga cheia. Toque contínuo e tela sempre acesa gastam mais "
            "do que uma tela de dados parada. Para cerca de 5 h de prova, a carga "
            "cheia em GPS comum é suficiente."
        ),
        setup_steps=(
            "Envie o treino pelo Garmin Connect e confirme que ele apareceu no relógio.",
            "Para iniciar: botão Action, Corrida, menu Treinos, ou deslize até o calendário de treino no dia agendado.",
            "Auto Lap de 1,00 km nas configurações da Corrida, para não depender do toque molhado.",
            "Alerta de faixa de ritmo com os limites da zona calculada.",
            "Ensaie, num longão, pausar pelo botão e marcar volta pelo Back com a tela úmida.",
        ),
        screen_recommendations=(
            "Uma tela só na prova: ritmo, distância, frequência cardíaca e cronômetro.",
            "Auto Lap de 1,00 km como volta principal. O Back fica de reserva.",
            "Evite várias páginas por deslize. Suor e garoa atrapalham o toque.",
        ),
        run_workout_path="Botão de cima → Corrida → role para baixo → Treino → Biblioteca de treinos → treino do dia → Fazer treino",
        strength_workout_path="Botão de cima → Força → Treinos → treino do dia → Fazer treino",
        pacepro_path="Botão de cima → Corrida → deslize para cima → Treino → Planos PacePro → plano → Usar plano",
        course_path="Botão de cima → Corrida → deslize para cima → Navegação → Percursos → percurso → Fazer percurso",
    ),
    "vivoactive": LineProfile(
        line="Vívoactive",
        input_style=(
            "Dois botões e toque: START (em cima) abre as atividades e inicia/para o cronômetro; "
            "BACK (embaixo) volta. Na corrida, o BACK só marca volta se a Tecla de volta estiver ligada "
            "nas configurações da atividade. A configuração estável de prova é o Auto Lap."
        ),
        navigation="Segue percurso enviado pelo Garmin Connect e tem TracBack. Sem mapa embarcado.",
        metrics=(
            "HRV Status no sono, Body Battery, pontuação de sono, VO2 e tempo de recuperação. "
            "Training Readiness e Training Status não fazem parte da linha: a decisão do longão "
            "usa HRV, Body Battery, sono e a sensação das pernas."
        ),
        battery="Carga cheia na véspera. GPS contínuo por cerca de 5 h cabe no uso normal de prova.",
        setup_steps=(
            "Crie o treino no Garmin Connect e sincronize, ou copie o .fit pelo cabo.",
            "Para iniciar: START → Atividades → Corrida → role para baixo → Treino → Biblioteca de treinos → treino → Fazer treino → START.",
            "Auto Lap: na face do relógio, deslize para a esquerda → Atividades → Corrida → configurações da atividade → Auto Lap → Por distância → 1,00 km.",
            "Alerta de faixa: nas mesmas configurações, Alertas → Ritmo, com os limites rápido e lento da zona.",
            "Se quiser marcar volta no botão: configurações da Corrida → Voltas → Tecla de volta.",
        ),
        screen_recommendations=(
            "Tela única e números grandes: ritmo, distância, frequência cardíaca e cronômetro.",
            "Auto Lap de 1,00 km. Não conte com um toque preciso depois do km 30.",
        ),
        run_workout_path="START → Atividades → Corrida → role para baixo → Treino → Biblioteca de treinos → treino do dia → Fazer treino → START",
        strength_workout_path="START → Atividades → Academia → Força → Treinos → treino do dia → Fazer treino → START",
        pacepro_path="START → Corrida → deslize para cima → Treino → Planos PacePro → plano → START → Usar plano → START",
        course_path="START → Corrida → deslize para cima → Navegação → Percursos → percurso → Fazer percurso",
    ),
    "fenix": LineProfile(
        line="Fenix / Epix / Enduro",
        input_style=(
            "Cinco botões, no mesmo papel da Forerunner, mais toque. "
            "Dá para bloquear o toque no menu de controles e seguir só pelos botões."
        ),
        navigation=(
            "Mapas topográficos offline, curso, ClimbPro nas subidas do percurso "
            "e Stamina em tempo real."
        ),
        metrics=(
            "Conjunto completo: Training Readiness, Training Status, HRV Status, "
            "Stamina, carga e, conforme a geração, aclimatização ao calor."
        ),
        battery=(
            "Para maratona de rua, use GPS apenas. Multibanda e mapa colorido "
            "consomem carga sem mudar o controle do pace. Enduro e Fenix em "
            "modo econômico atravessam várias horas com folga."
        ),
        setup_steps=(
            "Envie o treino ou o PacePro pelo Garmin Connect.",
            "Na tela de início da Corrida, UP abre Treino, Navegação e o PacePro.",
            "Modo de satélite da atividade: GPS apenas.",
            "Bloqueie o toque se a previsão for chuva ou se o antebraço molhar as teclas.",
            "Auto Lap de 1,00 km e alerta de faixa de ritmo.",
        ),
        screen_recommendations=(
            "Tela 1: ritmo, ritmo da volta, distância, frequência cardíaca e cronômetro.",
            "Tela 2: Stamina e ritmo médio.",
            "ClimbPro só entra se o percurso tiver subidas longas. Em percurso plano, essa tela sai do loop.",
            "Deixe o mapa fora da tela principal. Ele não segura o pace.",
        ),
        run_workout_path="START → Corrida → segure MENU → Treino → Treinos → treino do dia → Fazer treino",
        strength_workout_path="START → Força → segure MENU → Treino → Treinos → treino do dia → Fazer treino",
        pacepro_path="START → Corrida → segure MENU → Treino → Planos PacePro → plano → Usar plano",
        course_path="START → Corrida → segure MENU → Navegação → Percursos → Fazer percurso",
    ),
    "instinct": LineProfile(
        line="Instinct",
        input_style=(
            "Botões físicos e painel de alto contraste. Modelos Solar usam MIP "
            "monocromático, legível no sol. O Instinct 3 também existe em AMOLED."
        ),
        navigation=(
            "Breadcrumb, TracBack e navegação a um ponto. Edições táticas mostram "
            "coordenada em dois formatos na mesma tela e têm modo stealth. "
            "Sem mapa topográfico colorido."
        ),
        metrics=(
            "VO2, sono, Body Battery e, conforme a geração, HRV e prontidão. "
            "O dado de prova continua sendo ritmo, distância e frequência cardíaca "
            "em tipo grande."
        ),
        battery=(
            "A linha foi feita para autonomia longa. GPS contínuo numa maratona "
            "de cerca de 5 h não é o limite do relógio. No AMOLED, evite tela "
            "sempre acesa no brilho máximo."
        ),
        setup_steps=(
            "Envie o treino pelo Garmin Connect.",
            "Abra Corrida pelos botões e entre em Treinos antes de dar a partida.",
            "Auto Lap de 1,00 km e alerta de faixa de ritmo.",
            "Modo stealth desligado: a prova precisa gravar o GPS.",
        ),
        screen_recommendations=(
            "Tela 1, números grandes: ritmo e distância.",
            "Tela 2: frequência cardíaca e cronômetro.",
            "Alto contraste já resolve a leitura no sol. Não dependa de um mapa que esta linha não embarca.",
        ),
        run_workout_path="GPS (START) → Corrida → segure MENU → Treino → Treinos → treino do dia → Fazer treino",
        strength_workout_path="GPS (START) → Força → segure MENU → Treino → Treinos → treino do dia → Fazer treino",
        pacepro_path="GPS (START) → Corrida → segure MENU → Treino → Planos PacePro → plano → Usar plano",
        course_path="GPS (START) → Corrida → segure MENU → Navegação → Percursos → Fazer percurso",
    ),
}

GENERIC_PROFILE = LineProfile(
    line="Garmin",
    input_style="Siga os botões ou o toque do seu modelo. A lógica do treino no Garmin Connect é a mesma.",
    navigation="Curso sincronizado pelo aplicativo, no que o modelo suportar.",
    metrics="Use sono, Body Battery e a sensação das pernas até cadastrar o modelo.",
    battery="Carga cheia e GPS no modo mais simples que ainda rastreie bem na cidade.",
    setup_steps=(
        "Crie o treino de corrida no Garmin Connect com alvo de ritmo e envie por Bluetooth.",
        "Na atividade Corrida, abra Treinos e inicie o treino antes do cronômetro.",
        "Auto Lap de 1,00 km e uma tela curta de ritmo, distância, frequência cardíaca e cronômetro.",
    ),
    screen_recommendations=(
        "Tela 1: ritmo, distância, frequência cardíaca e cronômetro.",
        "Auto Lap de 1,00 km.",
    ),
    run_workout_path="Atividade Corrida → Treino → Treinos → treino do dia (os nomes variam por modelo)",
    strength_workout_path="Atividade Força → Treinos → treino do dia (os nomes variam por modelo)",
    pacepro_path="Atividade Corrida → Treino → Planos PacePro, se o modelo tiver PacePro",
    course_path="Atividade Corrida → Navegação → Percursos, se o modelo seguir percurso",
)

MODEL_OVERRIDES: dict[str, ModelOverride] = {
    "forerunner 165": ModelOverride(
        notes=(
            "Manhã do longão neste modelo: HRV Status, Body Battery, sono e tempo de recuperação.",
            "Training Readiness e Training Status não fazem parte do Forerunner 165.",
            "No dia da prova, use PacePro com pace constante. Não há ClimbPro, Stamina nem mapa topográfico embarcado.",
            "Versão Music: deixe a música desligada para ficar na autonomia de GPS apenas.",
        ),
        extra_screens=(
            "Prova: START, Corrida, segure UP, Treino, Planos PacePro, aceite o plano de pace constante.",
            "O PacePro mostra o ritmo do trecho, o ritmo alvo e se você está à frente ou atrás no tempo.",
        ),
        battery=(
            "No 165, a Garmin declara cerca de 19 h em GPS apenas, sem música, "
            "e cerca de 7 h com música. Numa maratona perto de 5 h, GPS apenas "
            "e música desligada."
        ),
    ),
    "forerunner 55": ModelOverride(
        notes=(
            "Sem HRV Status: a manhã do longão usa Body Battery, sono e frequência cardíaca de repouso.",
            "PacePro disponível para a prova. Sem mapa; navegação por percurso simples.",
        ),
        metrics="Body Battery, sono, VO2, tempo de recuperação e PacePro. Sem HRV Status, Training Readiness ou Training Status.",
        battery="A Garmin declara até 20 h em modo GPS. Uma maratona de até 5 h cabe com folga.",
    ),
    "forerunner 255": ModelOverride(
        notes=(
            "HRV Status e relatório da manhã entram na decisão do longão, junto com o sono.",
            "Multibanda existe, mas GPS apenas basta na rua e rende mais bateria.",
        ),
        metrics="HRV Status, Training Status, Body Battery, sono, VO2, tempo de recuperação e PacePro.",
        battery="Até 30 h em GPS apenas, 25 h com todos os sistemas e 16 h em multibanda (255S: 26 h em GPS apenas).",
    ),
    "forerunner 265": ModelOverride(
        notes=(
            "Training Readiness e HRV Status entram na decisão da manhã, junto com o sono.",
            "A navegação é o traçado do curso. O mapa topográfico embarcado é da 965.",
        ),
        extra_screens=(
            "Coloque a prontidão de treino no relatório da manhã e o PacePro na prova.",
        ),
    ),
    "forerunner 965": ModelOverride(
        notes=(
            "Mapa embarcado, ClimbPro e Stamina estão disponíveis.",
            "Em maratona urbana, a tela que segura o pace continua sendo ritmo, volta, distância e frequência cardíaca.",
        ),
        extra_screens=(
            "Segunda tela: Stamina. ClimbPro só se o percurso tiver subida relevante.",
            "GPS apenas. O multibanda pode esperar a trilha.",
        ),
    ),
    "forerunner 570": ModelOverride(
        notes=(
            "Training Readiness, Training Status e HRV Status entram na decisão da manhã.",
            "Segue percurso por traçado; mapa colorido embarcado é da 970.",
        ),
        metrics="Training Readiness, Training Status, HRV Status, Body Battery, sono, VO2, dinâmica de corrida e PacePro.",
        battery="Até 18 h em modo GPS (47 mm: até 11 dias como smartwatch). Numa maratona de até 5 h, GPS apenas.",
    ),
    "forerunner 970": ModelOverride(
        notes=(
            "Mapa colorido embarcado, lanterna e métricas de tolerância de corrida.",
            "Economia de corrida e perda de velocidade por passada exigem a cinta HRM 600.",
        ),
        extra_screens=("Deixe o mapa fora da tela principal. GPS apenas na maratona de rua.",),
        metrics="Training Readiness, Training Status, HRV Status, Stamina, tolerância de corrida, VO2 e PacePro.",
        battery="Até 26 h em modo GPS e até 15 dias como smartwatch.",
    ),
    "venu 3": ModelOverride(
        notes=(
            "Não existe um quinto botão de Lap. Durante a atividade, o Back marca a volta e avança a etapa.",
            "HRV Status e Training Status ajudam na semana. ClimbPro e Stamina em tempo real não são o foco desta linha.",
        ),
    ),
    "venu 4": ModelOverride(
        notes=(
            "Dois botões e toque. Training Readiness e Training Status entram na decisão da manhã.",
            "Multibanda com SatIQ: deixe em SatIQ ou GPS apenas na rua.",
        ),
        metrics="Training Readiness, Training Status, HRV Status, Body Battery, sono, VO2, dinâmica de corrida e PacePro.",
        battery="45 mm: até 20 h em GPS apenas (41 mm: 15 h). Uma maratona de até 5 h cabe com folga.",
    ),
    "venu x1": ModelOverride(
        notes=(
            "Tela retangular grande, mapa colorido embarcado, ClimbPro e Stamina em tempo real.",
            "Sem multibanda: use GPS apenas ou todos os sistemas.",
        ),
        metrics="Training Readiness, Training Status, HRV Status, Stamina, VO2, dinâmica de corrida e PacePro.",
        battery="Até 16 h em GPS apenas e 14 h com todos os sistemas. Tela sempre acesa e mapa gastam mais.",
    ),
    "vivoactive 5": ModelOverride(
        notes=(
            "Trate a prova como tela única mais Auto Lap. O toque é o centro da interface.",
            "Sono e Body Battery guiam o dia do longão. Não espere o pacote de mapa e Stamina da Fenix.",
        ),
    ),
    "vivoactive 6": ModelOverride(
        notes=(
            "Dois botões (START em cima, BACK embaixo) e toque. Na prova, Auto Lap de 1 km; "
            "o BACK só marca volta com a Tecla de volta ligada.",
            "Sem Training Readiness e Training Status: a manhã do longão usa HRV Status, Body Battery e sono.",
            "Treinos .fit pelo cabo: se o relógio não aparecer no computador, troque o Modo USB "
            "(Configurações → Sistema → Avançado → Modo USB).",
            "Força: START → Atividades → Academia → Força. O relógio conta as repetições de cada série.",
        ),
        extra_screens=(
            "Prova: START → Corrida → deslize para cima → Treino → Planos PacePro → Usar plano.",
        ),
        metrics="HRV Status, Body Battery, sono, VO2, tempo de recuperação, dinâmica e potência de corrida e PacePro.",
        battery="Até 21 h em GPS apenas, 17 h com todos os sistemas e 8 h com música. Numa maratona, GPS apenas e sem música.",
    ),
    "fenix 7": ModelOverride(
        notes=(
            "Bloqueie o toque na chuva e mantenha os cinco botões.",
            "GPS apenas é o modo da maratona de rua. Stamina fica na segunda tela.",
        ),
    ),
    "epix": ModelOverride(
        notes=(
            "A Epix segue o perfil Fenix com tela AMOLED. Bloquear o toque evita clique acidental e poupa carga.",
        ),
    ),
    "enduro 2": ModelOverride(
        notes=(
            "A autonomia é o ponto forte. GPS apenas ainda termina uma maratona de cerca de 5 h com folga larga.",
        ),
    ),
    "instinct 2": ModelOverride(
        notes=(
            "MIP monocromático de alto contraste. Leia ritmo e distância em tipo grande, sem aumentar brilho de AMOLED.",
            "Edição tática: stealth desligado no dia da prova.",
        ),
    ),
    "instinct 3": ModelOverride(
        notes=(
            "Solar usa MIP de alto contraste. A versão AMOLED troca contraste de sol por cor e gasta mais tela.",
            "Os dois navegam por breadcrumb. Mapa topográfico colorido não faz parte da linha.",
        ),
    ),
}

LINE_MATCHERS: tuple[tuple[str, str], ...] = (
    ("instinct", "instinct"),
    ("enduro", "fenix"),
    ("epix", "fenix"),
    ("fenix", "fenix"),
    ("vivoactive", "vivoactive"),
    ("vívoactive", "vivoactive"),
    ("venu", "venu"),
    ("forerunner", "forerunner"),
)


def configure_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is None:
            continue
        try:
            reconfigure(encoding="utf-8")
        except (OSError, ValueError):
            continue


LINE_WORDS = ("forerunner", "vivoactive", "venu", "fenix", "epix", "enduro", "instinct")


def normalize_model_key(model: str) -> str:
    plain = unicodedata.normalize("NFKD", model).encode("ascii", "ignore").decode("ascii")
    key = " ".join(plain.strip().lower().replace("-", " ").split())
    key = ALIASES.get(key, key)
    key = re.sub(r"^fr ?(\d)", r"forerunner \1", key)
    key = re.sub(r"^va ?(\d)", r"vivoactive \1", key)
    for word in LINE_WORDS:
        key = re.sub(rf"\b{word}(?=\d)", f"{word} ", key)
    return key


def detect_line(model_key: str) -> str | None:
    for token, line_key in LINE_MATCHERS:
        if token in model_key:
            return line_key
    return None


def known_models() -> list[str]:
    return sorted(key.title() for key in MODEL_OVERRIDES)


def match_override(model_key: str) -> ModelOverride | None:
    exact = MODEL_OVERRIDES.get(model_key)
    if exact is not None:
        return exact
    matches: list[str] = []
    for key in MODEL_OVERRIDES:
        if model_key.startswith(key + " "):
            matches.append(key)
            continue
        if model_key.startswith(key):
            remainder = model_key[len(key) :]
            if remainder and not remainder[0].isdigit():
                matches.append(key)
    if not matches:
        return None
    return MODEL_OVERRIDES[max(matches, key=len)]


def resolve_watch(model: str) -> ResolvedWatch:
    display = " ".join(model.strip().split())
    if not display:
        raise ValueError("Informe o modelo do relógio.")
    model_key = normalize_model_key(display)
    line_key = detect_line(model_key)
    profile = LINE_PROFILES[line_key] if line_key else GENERIC_PROFILE
    override = match_override(model_key)
    notes: list[str] = list(override.notes) if override else []
    if override is None and line_key is not None:
        notes.append(
            f"Perfil geral da linha {profile.line}. "
            "Cadastre este modelo em MODEL_OVERRIDES para notas exclusivas."
        )
    if line_key is None:
        notes.append(
            "Modelo fora do catálogo. O plano usa o perfil Garmin genérico. "
            "Inclua a linha em LINE_PROFILES ou o modelo em MODEL_OVERRIDES."
        )
    extra = override.extra_screens if override else ()
    return ResolvedWatch(
        model=display,
        line=profile.line,
        cataloged_line=line_key is not None,
        exact_model=override is not None,
        input_style=profile.input_style,
        navigation=profile.navigation,
        metrics=(override.metrics if override and override.metrics else profile.metrics),
        battery=(override.battery if override and override.battery else profile.battery),
        setup_steps=profile.setup_steps,
        screen_recommendations=profile.screen_recommendations + extra,
        model_notes=tuple(notes),
        run_workout_path=profile.run_workout_path,
        strength_workout_path=profile.strength_workout_path,
        pacepro_path=profile.pacepro_path,
        course_path=profile.course_path,
    )


def parse_pace(value: object) -> int:
    text = str(value).strip().lower().replace("min/km", "").strip()
    parts = text.split(":")
    if len(parts) != 2 or not parts[0].isdigit() or not parts[1].isdigit():
        raise ValueError("Informe o pace como MM:SS, por exemplo 06:40.")
    minutes = int(parts[0])
    seconds = int(parts[1])
    if not 0 <= minutes <= 59 or not 0 <= seconds <= 59:
        raise ValueError("O pace precisa ter minutos e segundos entre 00 e 59.")
    total = minutes * 60 + seconds
    if total <= 0:
        raise ValueError("O pace precisa ser maior que 00:00.")
    return total


def parse_finish_time(value: object) -> int:
    parts = str(value).strip().split(":")
    if len(parts) != 3 or not all(part.isdigit() for part in parts):
        raise ValueError("Informe o tempo alvo como H:MM:SS, por exemplo 4:41:18.")
    hours, minutes, seconds = (int(part) for part in parts)
    if minutes > 59 or seconds > 59:
        raise ValueError("O tempo alvo precisa ter minutos e segundos entre 00 e 59.")
    total = hours * 3600 + minutes * 60 + seconds
    if total <= 0:
        raise ValueError("O tempo alvo precisa ser maior que zero.")
    return total


def parse_distance(value: object, label: str = "A distância") -> Decimal:
    text = str(value).strip().replace(",", ".")
    try:
        distance = Decimal(text)
    except InvalidOperation as exc:
        raise ValueError(f"{label} em quilômetros não é um número válido.") from exc
    if distance <= 0:
        raise ValueError(f"{label} precisa ser maior que zero.")
    return distance.quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)


def parse_tolerance(value: object, pace_seconds: int) -> int:
    try:
        seconds = int(str(value).strip())
    except (TypeError, ValueError) as exc:
        raise ValueError("A tolerância deve ser um número inteiro de segundos.") from exc
    if seconds < 0 or seconds >= pace_seconds:
        raise ValueError("A tolerância precisa ser zero ou mais, e menor que o pace.")
    return seconds


def parse_race_date(value: object) -> date:
    try:
        return datetime.strptime(str(value).strip(), "%Y-%m-%d").date()
    except ValueError as exc:
        raise ValueError("A data deve estar no formato AAAA-MM-DD.") from exc


def format_pace(total_seconds: int) -> str:
    minutes, seconds = divmod(total_seconds, 60)
    return f"{minutes:02d}:{seconds:02d}"


def format_duration(total_seconds: int) -> str:
    hours, remainder = divmod(total_seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}"


def format_km(distance: Decimal) -> str:
    quantized = distance.quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)
    if quantized == quantized.to_integral_value():
        text = str(int(quantized))
    else:
        text = format(quantized, "f").rstrip("0").rstrip(".")
    return text.replace(".", ",") + " km"


def format_date(value: date) -> str:
    return value.strftime("%d/%m/%Y")


def elapsed_seconds(distance_km: Decimal, pace_seconds: int) -> int:
    total = (distance_km * Decimal(pace_seconds)).quantize(Decimal("1"), rounding=ROUND_HALF_UP)
    return int(total)


def json_number(value: Decimal) -> int | float:
    if value == value.to_integral_value():
        return int(value)
    return float(value)


def build_splits(distance_km: Decimal, pace_seconds: int, split_km: Decimal) -> list[Split]:
    marks: list[Decimal] = []
    cursor = split_km
    while cursor < distance_km:
        marks.append(cursor)
        cursor += split_km
    if not marks or marks[-1] != distance_km:
        marks.append(distance_km)

    splits: list[Split] = []
    previous = Decimal("0")
    for mark in marks:
        segment = mark - previous
        splits.append(
            Split(
                mark_km=mark,
                segment_km=segment,
                segment_seconds=elapsed_seconds(segment, pace_seconds),
                cumulative_seconds=elapsed_seconds(mark, pace_seconds),
                pace_seconds=pace_seconds,
            )
        )
        previous = mark
    return splits


def countdown_text(race_day: date, today: date | None = None) -> str:
    current = today or date.today()
    delta = (race_day - current).days
    if delta > 1:
        return f"Faltam {delta} dias."
    if delta == 1:
        return "Falta 1 dia."
    if delta == 0:
        return "A prova é hoje."
    return "A data informada já passou. Os tempos abaixo seguem o pace configurado."


FIT_EPOCH = datetime(1989, 12, 31, tzinfo=timezone.utc)
FIT_CRC_TABLE = (
    0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401,
    0xA001, 0x6C00, 0x7800, 0xB401, 0x5000, 0x9C01, 0x8801, 0x4400,
)
FIT_ENUM, FIT_STRING, FIT_UINT16, FIT_UINT32, FIT_UINT32Z = 0x00, 0x07, 0x84, 0x86, 0x8C
FIT_PACK = {FIT_ENUM: "<B", FIT_UINT16: "<H", FIT_UINT32: "<I", FIT_UINT32Z: "<I"}
FIT_INVALID_ENUM = 0xFF
FIT_INVALID_UINT16 = 0xFFFF
FIT_INVALID_UINT32 = 0xFFFFFFFF
FIT_NAME_SIZE = 16

FIT_FILE_ID = 0
FIT_WORKOUT = 26
FIT_WORKOUT_STEP = 27
FIT_FILE_TYPE_WORKOUT = 5
FIT_MANUFACTURER_DEVELOPMENT = 255
FIT_SPORT_RUNNING = 1
FIT_SPORT_TRAINING = 10
FIT_SUB_SPORT_GENERIC = 0
FIT_SUB_SPORT_STRENGTH = 20
FIT_DURATION_TIME = 0
FIT_DURATION_DISTANCE = 1
FIT_DURATION_REPEAT_STEPS = 6
FIT_DURATION_REPS = 29
FIT_TARGET_SPEED = 0
FIT_TARGET_HEART_RATE = 1
FIT_TARGET_OPEN = 2
FIT_INTENSITY_ACTIVE = 0
FIT_INTENSITY_REST = 1
FIT_INTENSITY_WARMUP = 2
FIT_INTENSITY_COOLDOWN = 3
FIT_INTENSITY_RECOVERY = 4

FIT_FILE_ID_FIELDS = ((0, 1, FIT_ENUM), (1, 2, FIT_UINT16), (2, 2, FIT_UINT16), (3, 4, FIT_UINT32Z), (4, 4, FIT_UINT32))
FIT_WORKOUT_FIELDS = ((4, 1, FIT_ENUM), (11, 1, FIT_ENUM), (6, 2, FIT_UINT16), (8, FIT_NAME_SIZE, FIT_STRING))
FIT_STEP_FIELDS = (
    (254, 2, FIT_UINT16),
    (0, FIT_NAME_SIZE, FIT_STRING),
    (1, 1, FIT_ENUM),
    (2, 4, FIT_UINT32),
    (3, 1, FIT_ENUM),
    (4, 4, FIT_UINT32),
    (5, 4, FIT_UINT32),
    (6, 4, FIT_UINT32),
    (7, 1, FIT_ENUM),
    (10, 2, FIT_UINT16),
    (11, 2, FIT_UINT16),
)

DEFAULT_TRAININGS_DIR = Path(__file__).resolve().parent / "Treinos"
DAY_SLUGS = ("segunda", "terca", "quarta", "quinta", "sexta", "sabado", "domingo")
DAY_NAMES = ("Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado", "Domingo")
MONTHS = ("jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez")


@dataclass(frozen=True)
class FitStep:
    name: str
    duration_type: int
    duration_value: int
    target_type: int = FIT_TARGET_OPEN
    target_value: int = 0
    low: int = FIT_INVALID_UINT32
    high: int = FIT_INVALID_UINT32
    intensity: int = FIT_INTENSITY_ACTIVE
    category: int = FIT_INVALID_UINT16
    exercise: int = FIT_INVALID_UINT16


@dataclass(frozen=True)
class RunSegment:
    label: str
    unit: str
    amount: Decimal
    target: str
    intensity: int = FIT_INTENSITY_ACTIVE


@dataclass(frozen=True)
class RunSession:
    title: str
    slug: str
    segments: tuple[RunSegment, ...]


@dataclass(frozen=True)
class StrengthExercise:
    label: str
    short: str
    category: int
    exercise: int
    sets: int
    reps: int = 0
    seconds: int = 0
    rest_seconds: int = 60
    per_side: bool = False


@dataclass(frozen=True)
class StrengthSession:
    title: str
    slug: str
    label: str
    exercises: tuple[StrengthExercise, ...]


@dataclass(frozen=True)
class DayPlan:
    run: RunSession | None = None
    strength: str | None = None
    race: bool = False


@dataclass(frozen=True)
class TrainingWeek:
    weeks_before_race: int
    phase: str
    days: tuple[DayPlan, ...]


@dataclass(frozen=True)
class WeekVolume:
    quality: int
    easy: int
    easy_short: int
    jog: int
    long_z2: int = 0
    long_pace: int = 0


@dataclass(frozen=True)
class DistanceProfile:
    name: str
    max_km: Decimal
    pace_label: str
    start_long: int
    peak_long: int
    long_step: int
    long_pace_share: Decimal
    peak_week: WeekVolume
    taper: tuple[WeekVolume, WeekVolume, WeekVolume]


def warmup(minutes: int) -> RunSegment:
    return RunSegment("Aquecimento", "min", Decimal(minutes), "livre", FIT_INTENSITY_WARMUP)


def cooldown(minutes: int) -> RunSegment:
    return RunSegment("Desaquecimento", "min", Decimal(minutes), "livre", FIT_INTENSITY_COOLDOWN)


def pace_block(km: object, label: str = "Ritmo maratona") -> RunSegment:
    return RunSegment(label, "km", Decimal(str(km)), "pace")


def easy(km: object, label: str = "Leve Z2") -> RunSegment:
    return RunSegment(label, "km", Decimal(str(km)), "z2")


def jog(km: object) -> RunSegment:
    return RunSegment("Trote", "km", Decimal(str(km)), "livre")


def ritmo_session(km: int, label: str) -> RunSession:
    return RunSession(f"Ritmo{km}k", f"ritmo-{km}km", (warmup(15 if km >= 6 else 10), pace_block(km, label), cooldown(10)))


def longao_session(z2_km: int, pace_km: int, label: str) -> RunSession:
    total = z2_km + pace_km
    finish = (pace_block(pace_km, label),) if pace_km else ()
    slug = f"longao-{total}km" if pace_km else f"longao-{total}km-leve"
    return RunSession(f"Longao{total}k", slug, (easy(z2_km, "Longao Z2"), *finish, cooldown(5)))


def leve_session(km: int) -> RunSession:
    return RunSession(f"Leve{km}k", f"leve-{km}km", (easy(km),))


def trote_session(km: int) -> RunSession:
    return RunSession(f"Trote{km}k", f"trote-{km}km", (jog(km),))

GOBLET = ("Agachamento goblet", "Agach. goblet", 28, 37)
REVERSE_LUNGE = ("Afundo reverso", "Afundo reverso", 17, 82)
HIP_RAISE = ("Ponte de glúteo", "Ponte gluteo", 10, 11)
LATERAL_WALK = ("Caminhada lateral com mini band", "Passada lateral", 11, 11)
PLANK = ("Prancha frontal", "Prancha", 19, 43)
SIDE_PLANK = ("Prancha lateral", "Prancha lateral", 19, 66)
ROMANIAN = ("Levantamento terra romeno", "Terra romeno", 8, 23)
SINGLE_ROMANIAN = ("Romeno unilateral", "Romeno 1 perna", 8, 14)
STANDING_CALF = ("Panturrilha em pé", "Pant. em pe", 1, 18)
SEATED_CALF = ("Panturrilha sentado (sóleo)", "Pant. sentado", 1, 6)
DEAD_BUG = ("Dead bug", "Dead bug", 11, 1)
BIRD_DOG = ("Bird dog", "Bird dog", 13, 12)


def exercise(base: tuple[str, str, int, int], sets: int, reps: int = 0, seconds: int = 0,
             rest: int = 60, per_side: bool = False) -> StrengthExercise:
    label, short, category, name = base
    return StrengthExercise(label, short, category, name, sets, reps, seconds, rest, per_side)


STRENGTH_SESSIONS: dict[str, StrengthSession] = {
    "A": StrengthSession("ForcaA", "forca-a", "Força A (quadríceps, glúteo, tronco)", (
        exercise(GOBLET, 3, reps=8, rest=90),
        exercise(REVERSE_LUNGE, 3, reps=8, rest=90, per_side=True),
        exercise(HIP_RAISE, 3, reps=10),
        exercise(LATERAL_WALK, 2, reps=12, rest=45, per_side=True),
        exercise(PLANK, 3, seconds=40, rest=45),
        exercise(SIDE_PLANK, 2, seconds=30, rest=45, per_side=True),
    )),
    "B": StrengthSession("ForcaB", "forca-b", "Força B (posterior, panturrilha, core)", (
        exercise(ROMANIAN, 3, reps=8, rest=90),
        exercise(SINGLE_ROMANIAN, 3, reps=8, rest=90, per_side=True),
        exercise(STANDING_CALF, 3, reps=12),
        exercise(SEATED_CALF, 3, reps=15),
        exercise(DEAD_BUG, 3, reps=8, rest=45, per_side=True),
        exercise(BIRD_DOG, 2, reps=8, rest=45, per_side=True),
    )),
    "reduzida": StrengthSession("ForcaRed", "forca-reduzida", "Força reduzida (2 séries, sem carga nova)", (
        exercise(GOBLET, 2, reps=8, rest=90),
        exercise(REVERSE_LUNGE, 2, reps=8, rest=90, per_side=True),
        exercise(ROMANIAN, 2, reps=8, rest=90),
        exercise(SEATED_CALF, 2, reps=15),
        exercise(PLANK, 2, seconds=40, rest=45),
        exercise(DEAD_BUG, 2, reps=8, rest=45, per_side=True),
    )),
    "ativacao": StrengthSession("Ativacao", "ativacao", "Ativação leve (semana da prova)", (
        exercise(SEATED_CALF, 2, reps=12),
        exercise(DEAD_BUG, 2, reps=8, rest=45, per_side=True),
    )),
}

REST = DayPlan()

# Semana de 7 dias terminando no dia da prova: descanso, ritmo, leve + força,
# leve + força, descanso, trote, longão (ou a prova). "peak_week" é a semana
# de pico sem o longão; "taper" são as semanas a 2, 1 e 0 da prova.
DISTANCE_PROFILES: tuple[DistanceProfile, ...] = (
    DistanceProfile("5 km", Decimal("7.5"), "Ritmo 5 km", 6, 10, 1, Decimal("0.2"),
                    WeekVolume(4, 6, 5, 3),
                    (WeekVolume(4, 5, 5, 3, 6, 2), WeekVolume(3, 5, 4, 3, 5, 2), WeekVolume(2, 4, 3, 2))),
    DistanceProfile("10 km", Decimal("15"), "Ritmo 10 km", 8, 14, 1, Decimal("0.2"),
                    WeekVolume(6, 7, 5, 4),
                    (WeekVolume(6, 6, 5, 4, 9, 3), WeekVolume(5, 5, 5, 3, 7, 3), WeekVolume(3, 4, 4, 3))),
    DistanceProfile("Meia maratona", Decimal("30"), "Ritmo meia", 10, 20, 2, Decimal("0.3"),
                    WeekVolume(8, 8, 6, 5),
                    (WeekVolume(8, 7, 6, 4, 10, 6), WeekVolume(6, 6, 5, 4, 8, 4), WeekVolume(3, 5, 4, 3))),
    DistanceProfile("Maratona", Decimal("100"), "Ritmo maratona", 14, 32, 2, Decimal("0.25"),
                    WeekVolume(12, 10, 8, 6),
                    (WeekVolume(10, 8, 6, 5, 16, 8), WeekVolume(8, 7, 6, 4, 10, 6), WeekVolume(4, 5, 5, 3))),
)
PLAN_MAX_WEEKS = 16
TAPER_WEEKS = 3
CUTBACK_EVERY = 4
CUTBACK_FACTOR = Decimal("0.75")
LONG_PACE_FROM_WEEK = 8
MIN_LONG_KM = 4
TAPER_STRENGTH = (("A", "B"), ("reduzida", None), ("ativacao", None))


def profile_for(distance_km: Decimal) -> DistanceProfile:
    return next((p for p in DISTANCE_PROFILES if distance_km <= p.max_km), DISTANCE_PROFILES[-1])


def km_round(value: Decimal) -> int:
    return int(value.quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def scale_km(km: int, factor: Decimal, floor: int) -> int:
    return max(floor, km_round(Decimal(km) * factor)) if km else 0


def week_days(volume: WeekVolume, label: str, strength: tuple[str | None, str | None],
              long_run: RunSession | None) -> tuple[DayPlan, ...]:
    first, second = strength
    return (
        REST,
        DayPlan(run=ritmo_session(volume.quality, label)),
        DayPlan(run=leve_session(volume.easy), strength=first),
        DayPlan(run=leve_session(volume.easy_short), strength=second),
        REST,
        DayPlan(run=trote_session(volume.jog)),
        DayPlan(run=long_run) if long_run else DayPlan(race=True),
    )


def build_training_weeks(profile: DistanceProfile, count: int, current_long: Decimal | None) -> list[TrainingWeek]:
    label = profile.pace_label
    peak = Decimal(profile.peak_long)
    start = current_long if current_long is not None else Decimal(profile.start_long)
    reached = start if current_long is not None else peak
    build_count = max(0, count - TAPER_WEEKS)
    weeks: list[TrainingWeek] = []
    for index in range(build_count):
        before = count - 1 - index
        progress = start + (peak - start) * (index + 1) / build_count
        reached = min(peak, start + profile.long_step * (index + 1), progress)
        cutback = build_count >= CUTBACK_EVERY and before % CUTBACK_EVERY == 2
        long_km = max(MIN_LONG_KM, km_round(reached * CUTBACK_FACTOR if cutback else reached))
        pace_km = km_round(long_km * profile.long_pace_share) if not cutback and before <= LONG_PACE_FROM_WEEK else 0
        factor = Decimal(long_km) / peak
        top = profile.peak_week
        volume = WeekVolume(scale_km(top.quality, factor, 2), scale_km(top.easy, factor, 3),
                            scale_km(top.easy_short, factor, 3), scale_km(top.jog, factor, 2))
        phase = "Recuperação" if cutback else "Pico" if before == TAPER_WEEKS else "Construção"
        weeks.append(TrainingWeek(before, phase, week_days(volume, label, ("A", "B"),
                                                           longao_session(long_km - pace_km, pace_km, label))))

    ratio = min(Decimal(1), reached / peak)
    for before in range(min(count, TAPER_WEEKS) - 1, -1, -1):
        base = profile.taper[TAPER_WEEKS - 1 - before]
        volume = WeekVolume(scale_km(base.quality, ratio, 2), scale_km(base.easy, ratio, 3),
                            scale_km(base.easy_short, ratio, 3), scale_km(base.jog, ratio, 2))
        long_run = None
        if before:
            long_run = longao_session(scale_km(base.long_z2, ratio, 2), scale_km(base.long_pace, ratio, 1), label)
        phase = "Prova" if before == 0 else "Polimento"
        weeks.append(TrainingWeek(before, phase, week_days(volume, label, TAPER_STRENGTH[TAPER_WEEKS - 1 - before],
                                                           long_run)))
    return weeks


def fit_crc(data: bytes, crc: int = 0) -> int:
    for byte in data:
        for nibble in (byte & 0xF, (byte >> 4) & 0xF):
            tmp = FIT_CRC_TABLE[crc & 0xF]
            crc = (crc >> 4) & 0x0FFF
            crc = crc ^ tmp ^ FIT_CRC_TABLE[nibble]
    return crc


def speed_mm_per_s(pace_seconds: int) -> int:
    return int((Decimal(1_000_000) / Decimal(pace_seconds)).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


class FitWorkoutWriter:
    def __init__(self) -> None:
        self.records = bytearray()

    def define(self, local: int, global_number: int, fields: tuple[tuple[int, int, int], ...]) -> None:
        self.records += struct.pack("<BBBHB", 0x40 | local, 0, 0, global_number, len(fields))
        for number, size, base in fields:
            self.records += struct.pack("<BBB", number, size, base)

    def write(self, local: int, fields: tuple[tuple[int, int, int], ...], values: tuple[object, ...]) -> None:
        self.records.append(local)
        for (_, size, base), value in zip(fields, values, strict=True):
            if base == FIT_STRING:
                raw = str(value).encode("utf-8")[: size - 1]
                self.records += raw + b"\x00" * (size - len(raw))
            else:
                self.records += struct.pack(FIT_PACK[base], value)

    def to_bytes(self) -> bytes:
        header = struct.pack("<BBHI4s", 14, 0x10, 2132, len(self.records), b".FIT")
        header += struct.pack("<H", fit_crc(header))
        body = header + bytes(self.records)
        return body + struct.pack("<H", fit_crc(body))


def encode_fit_workout(name: str, sport: int, sub_sport: int, steps: list[FitStep], serial: int) -> bytes:
    created = int((datetime.now(timezone.utc) - FIT_EPOCH).total_seconds())
    writer = FitWorkoutWriter()
    writer.define(0, FIT_FILE_ID, FIT_FILE_ID_FIELDS)
    writer.write(0, FIT_FILE_ID_FIELDS, (
        FIT_FILE_TYPE_WORKOUT, FIT_MANUFACTURER_DEVELOPMENT, 0, (serial & 0xFFFFFFFF) or 1, created,
    ))
    writer.define(1, FIT_WORKOUT, FIT_WORKOUT_FIELDS)
    writer.write(1, FIT_WORKOUT_FIELDS, (sport, sub_sport, len(steps), name[: FIT_NAME_SIZE - 1]))
    writer.define(2, FIT_WORKOUT_STEP, FIT_STEP_FIELDS)
    for index, step in enumerate(steps):
        writer.write(2, FIT_STEP_FIELDS, (
            index, step.name, step.duration_type, step.duration_value, step.target_type,
            step.target_value, step.low, step.high, step.intensity, step.category, step.exercise,
        ))
    return writer.to_bytes()


def segment_steps(segments: tuple[RunSegment, ...], zone: PaceZone) -> list[FitStep]:
    steps: list[FitStep] = []
    for segment in segments:
        if segment.unit == "min":
            duration_type = FIT_DURATION_TIME
            duration = int(segment.amount * 60_000)
        elif segment.unit == "s":
            duration_type = FIT_DURATION_TIME
            duration = int(segment.amount * 1000)
        else:
            duration_type = FIT_DURATION_DISTANCE
            duration = int((segment.amount * 100_000).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
        if segment.target == "pace":
            steps.append(FitStep(
                segment.label, duration_type, duration, FIT_TARGET_SPEED, 0,
                speed_mm_per_s(zone.slower_seconds), speed_mm_per_s(zone.faster_seconds),
                segment.intensity,
            ))
        elif segment.target == "z2":
            steps.append(FitStep(segment.label, duration_type, duration, FIT_TARGET_HEART_RATE, 2,
                                 intensity=segment.intensity))
        else:
            steps.append(FitStep(segment.label, duration_type, duration, intensity=segment.intensity))
    return steps


def strength_steps(session: StrengthSession) -> list[FitStep]:
    steps: list[FitStep] = []
    for index, item in enumerate(session.exercises):
        for set_number in range(item.sets):
            if item.reps:
                steps.append(FitStep(item.short, FIT_DURATION_REPS, item.reps,
                                     category=item.category, exercise=item.exercise))
            else:
                seconds = item.seconds * (2 if item.per_side else 1)
                steps.append(FitStep(item.short, FIT_DURATION_TIME, seconds * 1000,
                                     category=item.category, exercise=item.exercise))
            last = index == len(session.exercises) - 1 and set_number == item.sets - 1
            if not last:
                steps.append(FitStep("Descanso", FIT_DURATION_TIME, item.rest_seconds * 1000,
                                     intensity=FIT_INTENSITY_REST))
    return steps


def describe_strength(session: StrengthSession) -> str:
    parts = []
    for item in session.exercises:
        side = " por lado" if item.per_side else ""
        volume = f"{item.sets}x{item.reps}" if item.reps else f"{item.sets}x{item.seconds} s"
        parts.append(f"{item.label} {volume}{side}")
    return "; ".join(parts)


def workout_label(day: date, title: str) -> str:
    return f"{day.day:02d}{MONTHS[day.month - 1]} {title}"[: FIT_NAME_SIZE - 1]


def week_folder(number: int, start: date, race_week: bool) -> str:
    end = start + timedelta(days=6)
    name = (
        f"semana-{number}_{start.day:02d}-{MONTHS[start.month - 1]}"
        f"-a-{end.day:02d}-{MONTHS[end.month - 1]}"
    )
    return name + ("-prova" if race_week else "")


class MarathonPlan:
    def __init__(
        self,
        watch: ResolvedWatch,
        event_name: str,
        event_city: str,
        race_day: date,
        distance_km: Decimal,
        split_km: Decimal,
        zone: PaceZone,
        splits: list[Split],
        current_long_km: Decimal | None = None,
        plan_start: date | None = None,
    ) -> None:
        self.profile = profile_for(distance_km)
        self.current_long_km = current_long_km
        self.plan_start = plan_start or date.today()
        self.watch = watch
        self.event_name = event_name
        self.event_city = event_city
        self.race_day = race_day
        self.distance_km = distance_km
        self.split_km = split_km
        self.zone = zone
        self.splits = splits

    @classmethod
    def build(cls, config: AppConfig) -> MarathonPlan:
        distance_km = parse_distance(config.distance_km)
        if config.finish_time:
            total = Decimal(parse_finish_time(config.finish_time))
            pace_seconds = int((total / distance_km).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
            if not 1 <= pace_seconds <= 3599:
                raise ValueError("Esse tempo alvo gera um pace fora de 00:01 a 59:59 por km.")
        else:
            pace_seconds = parse_pace(config.pace)
        split_km = parse_distance(config.split_km, "O intervalo de parcial")
        tolerance = parse_tolerance(config.tolerance_seconds, pace_seconds)
        race_day = parse_race_date(config.race_date)
        long_text = str(config.current_long_km or "").strip()
        current_long = parse_distance(long_text, "O maior longão recente") if long_text else None
        start_text = str(config.plan_start or "").strip()
        plan_start = parse_race_date(start_text) if start_text else None
        zone = PaceZone(
            tolerance_seconds=tolerance,
            faster_seconds=pace_seconds - tolerance,
            target_seconds=pace_seconds,
            slower_seconds=pace_seconds + tolerance,
        )
        return cls(
            watch=resolve_watch(config.model),
            event_name=str(config.event_name).strip() or str(DEFAULTS["event_name"]),
            event_city=str(config.event_city).strip() or str(DEFAULTS["event_city"]),
            race_day=race_day,
            distance_km=distance_km,
            split_km=split_km,
            zone=zone,
            splits=build_splits(distance_km, pace_seconds, split_km),
            current_long_km=current_long,
            plan_start=plan_start,
        )

    def finish_seconds(self, pace_seconds: int | None = None) -> int:
        pace = self.zone.target_seconds if pace_seconds is None else pace_seconds
        return elapsed_seconds(self.distance_km, pace)

    def to_dict(self) -> dict[str, object]:
        zone = self.zone
        return {
            "meta": {
                "planner_version": PLANNER_VERSION,
                "generated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
                "manual": "PLANO_MARATONA_GARMIN.md",
            },
            "event": {
                "name": self.event_name,
                "city": self.event_city,
                "date": self.race_day.isoformat(),
            },
            "watch": {
                "model": self.watch.model,
                "line": self.watch.line,
                "cataloged_line": self.watch.cataloged_line,
                "exact_model": self.watch.exact_model,
                "input_style": self.watch.input_style,
                "navigation": self.watch.navigation,
                "metrics": self.watch.metrics,
                "battery": self.watch.battery,
                "setup_steps": list(self.watch.setup_steps),
                "screen_recommendations": self._screen_lines(),
                "model_notes": list(self.watch.model_notes),
                "paths": {
                    "run_workout": self.watch.run_workout_path,
                    "strength_workout": self.watch.strength_workout_path,
                    "pacepro": self.watch.pacepro_path,
                    "course": self.watch.course_path,
                },
            },
            "target": {
                "distance_km": json_number(self.distance_km),
                "pace": zone.target_pace,
                "pace_seconds_per_km": zone.target_seconds,
                "speed_kmh": round(3600 / zone.target_seconds, 2),
                "finish_time": format_duration(self.finish_seconds()),
                "finish_seconds": self.finish_seconds(),
                "split_km": json_number(self.split_km),
                "tolerance_seconds": zone.tolerance_seconds,
            },
            "pace_zone": {
                "faster_pace": zone.faster_pace,
                "target_pace": zone.target_pace,
                "slower_pace": zone.slower_pace,
                "faster_finish": format_duration(self.finish_seconds(zone.faster_seconds)),
                "target_finish": format_duration(self.finish_seconds()),
                "slower_finish": format_duration(self.finish_seconds(zone.slower_seconds)),
            },
            "splits": [
                {
                    "mark_km": json_number(item.mark_km),
                    "segment_km": json_number(item.segment_km),
                    "segment_time": format_duration(item.segment_seconds),
                    "segment_seconds": item.segment_seconds,
                    "cumulative_time": format_duration(item.cumulative_seconds),
                    "cumulative_seconds": item.cumulative_seconds,
                    "pace": format_pace(item.pace_seconds),
                }
                for item in self.splits
            ],
            "models": known_models(),
            "workout_types": [
                {"key": key, "title": item.title, "description": item.description,
                 "warmup": item.warmup, "cooldown": item.cooldown}
                for key, item in WORKOUT_TYPES.items()
            ],
            "training": {
                "root": DEFAULT_TRAININGS_DIR.name,
                "files_ready": self.training_files_ready(),
                "profile": self.profile.name,
                "plan_start": self.plan_start.isoformat(),
                "current_long_km": json_number(self.current_long_km) if self.current_long_km is not None else None,
                "peak_long_km": self.profile.peak_long,
                "weeks": self.training_calendar(),
            },
        }

    def training_files_ready(self) -> bool:
        weeks = self.training_calendar()
        files = [
            DEFAULT_TRAININGS_DIR / session["file"]
            for week in weeks
            for day in week["days"]
            for session in (day["run"], day["strength"])
            if session
        ]
        return bool(files) and all(path.is_file() for path in files)

    def _screen_lines(self) -> list[str]:
        zone = self.zone
        dynamic = (
            f"Faixa de ritmo: {zone.faster_pace} a {zone.slower_pace} min/km "
            f"(alvo {zone.target_pace})."
        )
        return [dynamic, *self.watch.screen_recommendations]

    def render(self) -> str:
        zone = self.zone
        lines = [
            f"{self.event_name} — {self.event_city}",
            f"Data: {format_date(self.race_day)}. {countdown_text(self.race_day)}",
            f"Relógio: {self.watch.model} (linha {self.watch.line})",
            "",
            f"Distância: {format_km(self.distance_km)}",
            f"Pace alvo: {zone.target_pace} min/km",
            f"Tempo previsto: {format_duration(self.finish_seconds())}",
            "",
            f"Zona de pace (alvo ± {zone.tolerance_seconds} s)",
            f"  {'Rápido':<10}{zone.faster_pace} min/km    {format_duration(self.finish_seconds(zone.faster_seconds))}",
            f"  {'Alvo':<10}{zone.target_pace} min/km    {format_duration(self.finish_seconds())}",
            f"  {'Lento':<10}{zone.slower_pace} min/km    {format_duration(self.finish_seconds(zone.slower_seconds))}",
            "",
            (
                f"Parciais a cada {format_km(self.split_km)}. "
                "No relógio, a volta automática de 1 km mostra cada quilômetro. "
                "Estes acumulados são a conferência da marca."
            ),
            "",
            f"{'Marca':<14}{'Trecho':>12}{'Parcial':>12}{'Acumulado':>14}{'Pace':>10}",
        ]
        for item in self.splits:
            lines.append(
                f"{format_km(item.mark_km):<14}"
                f"{format_km(item.segment_km):>12}"
                f"{format_duration(item.segment_seconds):>12}"
                f"{format_duration(item.cumulative_seconds):>14}"
                f"{format_pace(item.pace_seconds):>10}"
            )
        lines.extend(["", "Perfil do relógio", f"  Operação: {self.watch.input_style}", f"  Navegação: {self.watch.navigation}"])
        lines.append(f"  Métricas: {self.watch.metrics}")
        lines.append(f"  Bateria: {self.watch.battery}")
        lines.extend(["", "Configuração"])
        for index, step in enumerate(self.watch.setup_steps, start=1):
            lines.append(f"  {index}. {step}")
        lines.extend(["", "Telas e alertas"])
        for step in self._screen_lines():
            lines.append(f"  - {step}")
        if self.watch.model_notes:
            lines.extend(["", "Notas deste modelo"])
            for note in self.watch.model_notes:
                lines.append(f"  - {note}")
        return "\n".join(lines)

    def export(self, path: Path) -> Path:
        destination = path.expanduser().resolve()
        destination.parent.mkdir(parents=True, exist_ok=True)
        payload = json.dumps(self.to_dict(), ensure_ascii=False, indent=2)
        destination.write_text(payload + "\n", encoding="utf-8")
        return destination

    def fit_workout_name(self, block_km: Decimal) -> str:
        block = format_km(block_km).replace(" km", "k")
        return f"Ritmo {self.zone.target_pace} {block}"[: FIT_NAME_SIZE - 1]

    def run_steps(self, session: RunSession) -> list[FitStep]:
        return segment_steps(session.segments, self.zone)

    def describe_run(self, session: RunSession) -> str:
        parts = []
        for segment in session.segments:
            if segment.unit == "min":
                parts.append(f"{segment.amount} min de {segment.label.lower()}")
            elif segment.target == "pace":
                parts.append(f"{format_km(segment.amount)} em {self.zone.faster_pace}–{self.zone.slower_pace} min/km")
            elif segment.target == "z2":
                parts.append(f"{format_km(segment.amount)} leve, FC na zona 2")
            else:
                parts.append(f"{format_km(segment.amount)} de trote livre")
        return " + ".join(parts)

    def export_fit_workout(self, path: Path, block_km: Decimal) -> Path:
        session = RunSession(
            self.fit_workout_name(block_km),
            "ritmo",
            (warmup(WARMUP_SECONDS // 60), pace_block(block_km, self.profile.pace_label), cooldown(COOLDOWN_SECONDS // 60)),
        )
        serial = int(datetime.now(timezone.utc).timestamp())
        payload = encode_fit_workout(session.title, FIT_SPORT_RUNNING, FIT_SUB_SPORT_GENERIC,
                                     self.run_steps(session), serial)
        destination = path.expanduser().resolve()
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(payload)
        return destination

    def plan_week_count(self) -> int:
        first_day = self.plan_start + timedelta(days=1)
        if first_day > self.race_day:
            return TAPER_WEEKS
        return min(PLAN_MAX_WEEKS, (self.race_day - first_day).days // 7 + 1)

    def training_weeks(self) -> list[TrainingWeek]:
        return build_training_weeks(self.profile, self.plan_week_count(), self.current_long_km)

    def training_calendar(self) -> list[dict[str, object]]:
        race_week_start = self.race_day - timedelta(days=6)
        weeks: list[dict[str, object]] = []
        for number, week in enumerate(self.training_weeks(), start=1):
            start = race_week_start - timedelta(weeks=week.weeks_before_race)
            folder = week_folder(number, start, week.weeks_before_race == 0)
            planned_km = Decimal("0")
            days: list[dict[str, object]] = []
            for index, plan_day in enumerate(week.days):
                day = start + timedelta(days=index)
                day_folder = f"{folder}/{index + 1}-{DAY_SLUGS[day.weekday()]}"
                entry: dict[str, object] = {
                    "date": day.isoformat(),
                    "weekday": DAY_NAMES[day.weekday()],
                    "folder": day_folder,
                    "race": plan_day.race,
                    "rest": not (plan_day.run or plan_day.strength or plan_day.race),
                    "run": None,
                    "strength": None,
                }
                if plan_day.run:
                    session = plan_day.run
                    km = sum((s.amount for s in session.segments if s.unit == "km"), Decimal("0"))
                    pace_km = sum((s.amount for s in session.segments if s.target == "pace"), Decimal("0"))
                    planned_km += km
                    entry["run"] = {
                        "key": session.slug,
                        "name": workout_label(day, session.title),
                        "description": self.describe_run(session),
                        "distance_km": json_number(km),
                        "pace_km": json_number(pace_km),
                        "pace_time": format_duration(elapsed_seconds(pace_km, self.zone.target_seconds)),
                        "segments": [
                            {"label": s.label, "unit": s.unit, "amount": json_number(s.amount), "target": s.target}
                            for s in session.segments
                        ],
                        "file": f"{day_folder}/treino-corrida/{day.isoformat()}_{session.slug}.fit",
                    }
                if plan_day.strength:
                    session = STRENGTH_SESSIONS[plan_day.strength]
                    entry["strength"] = {
                        "key": plan_day.strength,
                        "name": workout_label(day, session.title),
                        "label": session.label,
                        "exercises": [
                            {
                                "label": item.label,
                                "sets": item.sets,
                                "reps": item.reps,
                                "seconds": item.seconds,
                                "rest_seconds": item.rest_seconds,
                                "per_side": item.per_side,
                            }
                            for item in session.exercises
                        ],
                        "file": f"{day_folder}/treino-forca/{day.isoformat()}_{session.slug}.fit",
                    }
                days.append(entry)
            weeks.append({
                "number": number,
                "folder": folder,
                "start": start.isoformat(),
                "end": (start + timedelta(days=6)).isoformat(),
                "phase": week.phase,
                "race_week": week.weeks_before_race == 0,
                "planned_km": json_number(planned_km),
                "days": days,
            })
        return weeks

    def export_training_tree(self, root: Path) -> tuple[Path, int]:
        weeks = self.training_calendar()
        root = root.expanduser().resolve()
        serial = int(datetime.now(timezone.utc).timestamp())
        fit_count = 0
        sections: list[str] = []

        for week, plan_week in zip(weeks, self.training_weeks(), strict=True):
            rows = [
                f"### Semana {week['number']} ({week['phase']}) — "
                f"{format_date(date.fromisoformat(str(week['start'])))} "
                f"a {format_date(date.fromisoformat(str(week['end'])))}",
                f"Pasta: `{week['folder']}`",
                "",
                "| Dia | Corrida | Força |",
                "| --- | --- | --- |",
            ]
            for entry, plan_day in zip(week["days"], plan_week.days, strict=True):
                day = date.fromisoformat(str(entry["date"]))
                day_dir = root / str(entry["folder"])
                day_dir.mkdir(parents=True, exist_ok=True)
                run_text = "—"
                strength_text = "—"
                run = entry["run"]
                strength = entry["strength"]

                if run:
                    target = root / run["file"]
                    target.parent.mkdir(exist_ok=True)
                    serial += 1
                    target.write_bytes(encode_fit_workout(
                        run["name"], FIT_SPORT_RUNNING, FIT_SUB_SPORT_GENERIC,
                        self.run_steps(plan_day.run), serial,
                    ))
                    fit_count += 1
                    run_text = f"`{run['name']}`: {run['description']}"

                if strength:
                    session = STRENGTH_SESSIONS[strength["key"]]
                    target = root / strength["file"]
                    target.parent.mkdir(exist_ok=True)
                    serial += 1
                    target.write_bytes(encode_fit_workout(
                        strength["name"], FIT_SPORT_TRAINING, FIT_SUB_SPORT_STRENGTH, strength_steps(session), serial,
                    ))
                    fit_count += 1
                    strength_text = f"`{strength['name']}`: {session.label}. {describe_strength(session)}"

                if entry["race"]:
                    (day_dir / "PROVA.md").write_text(self.race_day_text(), encoding="utf-8")
                    run_text = f"**Prova**, PacePro em {self.zone.target_pace}. Ver `PROVA.md`"
                elif entry["rest"]:
                    (day_dir / "descanso.md").write_text(
                        f"# {entry['weekday']}, {format_date(day)}\n\nDescanso. Nenhum arquivo para o relógio.\n",
                        encoding="utf-8",
                    )
                    run_text = "Descanso"

                rows.append(f"| {entry['weekday']} {day.day:02d}/{day.month:02d} | {run_text} | {strength_text} |")
            sections.append("\n".join(rows))

        (root / "README.md").write_text(self.trainings_readme(sections), encoding="utf-8")
        return root, fit_count

    def race_day_text(self) -> str:
        zone = self.zone
        marks = "\n".join(
            f"| {format_km(item.mark_km)} | {format_duration(item.cumulative_seconds)} |" for item in self.splits
        )
        return (
            f"# Prova — {self.event_name}, {format_date(self.race_day)}\n\n"
            "Sem arquivo .fit neste dia. A prova usa o PacePro, criado no Garmin Connect:\n\n"
            "1. Garmin Connect → Treinamento e Planejamento → Estratégias de Pace PacePro.\n"
            f"2. Distância {format_km(self.distance_km)}, pace {zone.target_pace}, estratégia constante. Enviar ao relógio.\n"
            f"3. No relógio ({self.watch.model}): {self.watch.pacepro_path}.\n\n"
            f"Faixa: {zone.faster_pace} a {zone.slower_pace} min/km. "
            f"Tempo alvo: {format_duration(self.finish_seconds())}. Auto Lap de 1 km.\n\n"
            "| Marca | Acumulado |\n| --- | --- |\n"
            f"{marks}\n"
        )

    def trainings_readme(self, sections: list[str]) -> str:
        zone = self.zone
        generated = datetime.now().strftime("%d/%m/%Y %H:%M")
        return (
            f"# Treinos — {self.event_name}, {format_date(self.race_day)}\n\n"
            f"Gerado por `python garmin_marathon_planner.py --treinos` em {generated}. "
            f"Pace alvo {zone.target_pace}, faixa {zone.faster_pace}–{zone.slower_pace} min/km. "
            f"Relógio: {self.watch.model}.\n\n"
            "## Importante\n\n"
            "A tela **Importar dados** do Garmin Connect (`connect.garmin.com/app/import-data`) não aceita "
            "estes arquivos. Ela só importa atividades já gravadas e recusa treinos com a mensagem "
            "\"Um de seus arquivos não foi aceito pelo sistema\". Os `.fit` desta pasta vão direto para "
            "o relógio, pelo cabo USB.\n\n"
            "## Como colocar uma semana no relógio\n\n"
            "1. Ligue o relógio ao computador pelo cabo de carga.\n"
            "2. No Explorador de Arquivos, abra o relógio → Armazenamento interno → `GARMIN` → `NewFiles`.\n"
            "3. Copie para `NewFiles` os `.fit` das pastas `treino-corrida` e `treino-forca` **da semana atual**. "
            "Só os arquivos, sem as pastas.\n"
            "4. Desconecte o cabo. O relógio move os arquivos para os treinos. Se algum não aparecer, reinicie o relógio.\n"
            f"5. Corrida: {self.watch.run_workout_path}. "
            f"Força: {self.watch.strength_workout_path}.\n\n"
            "Copie uma semana por vez. No domingo, apague os treinos da semana que passou "
            "(no relógio: Treinos → treino → Excluir) para não lotar a memória. "
            "O nome de cada treino começa pela data, por exemplo `13out Ritmo10k`, porque o relógio "
            "só diferencia os 15 primeiros caracteres.\n\n"
            "Treinos copiados pelo cabo ficam só no relógio. Não aparecem no aplicativo nem no calendário "
            "do Garmin Connect.\n\n"
            "## Ajuste de volume\n\n"
            f"Perfil {self.profile.name}: longão de pico de {self.profile.peak_long} km a três semanas da prova, "
            "semana de recuperação a cada quatro e as três últimas semanas de redução. "
            + (
                f"O longão parte do maior longão recente informado ({format_km(self.current_long_km)}). "
                if self.current_long_km is not None
                else "Informe o maior longão recente (`--longao`) para o plano partir do seu volume. "
            )
            + "Manhã com HRV baixo, Body Battery até 25 ou sono abaixo de 60 transforma o treino de ritmo em "
            "leve (regra da seção B do manual). Dor que muda a passada encerra o treino do dia.\n\n"
            "Trechos \"Leve Z2\" usam as zonas de frequência cardíaca do relógio. O relógio avisa quando a FC "
            "passa da zona 2.\n\n"
            "## Semanas\n\n"
            + "\n\n".join(sections)
            + "\n"
        )


DEFAULT_CUSTOM_DIR = DEFAULT_TRAININGS_DIR / "avulsos"
CUSTOM_MAX_KM = Decimal("100")


@dataclass(frozen=True)
class WorkoutType:
    title: str
    short: str
    description: str
    warmup: int
    cooldown: int


WORKOUT_TYPES = {
    "pace": WorkoutType("Corrida no pace", "Pace",
                        "A distância inteira na faixa de pace. O relógio vibra quando você sai da faixa.", 0, 0),
    "leve": WorkoutType("Rodagem leve", "Leve",
                        "Corrida confortável com alerta de frequência cardíaca na zona 2. O pace só estima o tempo.", 0, 0),
    "ritmo": WorkoutType("Ritmo", "Ritmo",
                         "Aquecimento, bloco contínuo no pace e desaquecimento.", 15, 10),
    "tiros": WorkoutType("Intervalado", "Tiro",
                         "Aquecimento, tiros no pace com trote de recuperação entre eles e desaquecimento. "
                         "O relógio conta as repetições.", 15, 10),
    "longao": WorkoutType("Longão", "Longao",
                          "Longão em zona 2, com os quilômetros finais no pace se quiser.", 0, 5),
}


@dataclass(frozen=True)
class WorkoutBlock:
    repeat: int
    segments: tuple[RunSegment, ...]


def parse_count(value: object, label: str, low: int, high: int) -> int:
    try:
        number = int(str(value).strip())
    except ValueError as exc:
        raise ValueError(f"{label} precisa ser um número inteiro.") from exc
    if not low <= number <= high:
        raise ValueError(f"{label} precisa ficar entre {low} e {high}.")
    return number


def km_tag(distance: Decimal) -> str:
    return format_km(distance).replace(" km", "k")


class CustomWorkout:
    def __init__(self, kind: str, watch: ResolvedWatch, zone: PaceZone, day: date, distance_km: Decimal,
                 warmup_min: int, cooldown_min: int, reps: int, rep_m: int, recovery_s: int,
                 finish_km: Decimal) -> None:
        self.kind = kind
        self.type = WORKOUT_TYPES[kind]
        self.watch = watch
        self.zone = zone
        self.day = day
        self.distance_km = distance_km
        self.warmup_min = warmup_min
        self.cooldown_min = cooldown_min
        self.reps = reps
        self.rep_m = rep_m
        self.recovery_s = recovery_s
        self.finish_km = finish_km

    @classmethod
    def build(cls, config: AppConfig) -> CustomWorkout:
        kind = str(config.workout_kind)
        if kind not in WORKOUT_TYPES:
            raise ValueError(f"Tipo de treino desconhecido: {kind}. Use {', '.join(WORKOUT_TYPES)}.")
        if config.finish_time:
            raise ValueError("No treino avulso, informe o alvo com --pace.")
        info = WORKOUT_TYPES[kind]
        raw = config.workout or {}

        def value(key: str, default: object) -> object:
            item = raw.get(key)
            return default if item is None or str(item).strip() == "" else item

        pace = parse_pace(config.pace)
        tolerance = parse_tolerance(config.tolerance_seconds, pace)
        distance = parse_distance(value("km", "8"), "A distância do treino")
        if distance > CUSTOM_MAX_KM:
            raise ValueError(f"A distância do treino vai até {format_km(CUSTOM_MAX_KM)}.")
        finish_text = str(value("finish_km", "0")).strip().replace(",", ".")
        try:
            finish = Decimal(finish_text).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)
        except InvalidOperation as exc:
            raise ValueError("O final no pace precisa ser um número de km.") from exc
        if kind == "longao" and not Decimal("0") <= finish < distance:
            raise ValueError("O final no pace precisa ser zero ou menor que a distância do longão.")
        return cls(
            kind=kind,
            watch=resolve_watch(config.model),
            zone=PaceZone(tolerance, pace - tolerance, pace, pace + tolerance),
            day=parse_race_date(value("day", date.today().isoformat())),
            distance_km=distance,
            warmup_min=parse_count(value("warmup", info.warmup), "O aquecimento (min)", 0, 60),
            cooldown_min=parse_count(value("cooldown", info.cooldown), "O desaquecimento (min)", 0, 60),
            reps=parse_count(value("reps", 6), "O número de tiros", 1, 40),
            rep_m=parse_count(value("rep_m", 400), "A distância do tiro (m)", 50, 5000),
            recovery_s=parse_count(value("recovery_s", 90), "A recuperação (s)", 0, 900),
            finish_km=finish if kind == "longao" else Decimal("0"),
        )

    def blocks(self) -> list[WorkoutBlock]:
        blocks: list[WorkoutBlock] = []
        if self.warmup_min:
            blocks.append(WorkoutBlock(1, (warmup(self.warmup_min),)))
        if self.kind == "tiros":
            shot = pace_block(Decimal(self.rep_m) / 1000, f"Tiro {self.rep_m} m")
            rest = (RunSegment("Recuperacao", "s", Decimal(self.recovery_s), "livre", FIT_INTENSITY_RECOVERY),)
            blocks.append(WorkoutBlock(self.reps, (shot, *(rest if self.recovery_s else ()))))
        elif self.kind == "leve":
            blocks.append(WorkoutBlock(1, (easy(self.distance_km),)))
        elif self.kind == "longao":
            finish = (pace_block(self.finish_km, "Final no pace"),) if self.finish_km else ()
            blocks.append(WorkoutBlock(1, (easy(self.distance_km - self.finish_km, "Longao Z2"), *finish)))
        else:
            label = "Bloco no pace" if self.kind == "ritmo" else "No pace"
            blocks.append(WorkoutBlock(1, (pace_block(self.distance_km, label),)))
        if self.cooldown_min:
            blocks.append(WorkoutBlock(1, (cooldown(self.cooldown_min),)))
        return blocks

    def title(self) -> str:
        if self.kind == "tiros":
            return f"Tiro{self.reps}x{self.rep_m}"
        return f"{self.type.short}{km_tag(self.distance_km)}"

    def name(self) -> str:
        return workout_label(self.day, self.title())

    def file_name(self) -> str:
        if self.kind == "tiros":
            slug = f"tiros-{self.reps}x{self.rep_m}m"
        else:
            slug = f"{self.kind}-{km_tag(self.distance_km).replace(',', '-').replace('k', 'km')}"
        return f"{self.day.isoformat()}_{slug}.fit"

    def segment_seconds(self, segment: RunSegment) -> int:
        if segment.unit == "min":
            return int(segment.amount * 60)
        if segment.unit == "s":
            return int(segment.amount)
        return elapsed_seconds(segment.amount, self.zone.target_seconds)

    def measured_km(self) -> Decimal:
        return sum((s.amount * b.repeat for b in self.blocks() for s in b.segments if s.unit == "km"), Decimal("0"))

    def estimated_seconds(self) -> int:
        return sum(self.segment_seconds(s) * b.repeat for b in self.blocks() for s in b.segments)

    def fit_steps(self) -> list[FitStep]:
        steps: list[FitStep] = []
        for block in self.blocks():
            first = len(steps)
            steps.extend(segment_steps(block.segments, self.zone))
            if block.repeat > 1:
                steps.append(FitStep("Repetir", FIT_DURATION_REPEAT_STEPS, first, FIT_INVALID_ENUM,
                                     block.repeat, intensity=FIT_INVALID_ENUM))
        return steps

    def segment_text(self, segment: RunSegment) -> tuple[str, str]:
        if segment.unit == "min":
            duration = f"{segment.amount} min"
        elif segment.unit == "s":
            duration = f"{segment.amount} s"
        elif segment.amount < 1:
            duration = f"{int(segment.amount * 1000)} m"
        else:
            duration = format_km(segment.amount)
        target = {
            "pace": f"{self.zone.faster_pace}–{self.zone.slower_pace} /km",
            "z2": "FC zona 2",
        }.get(segment.target, "livre")
        return duration, target

    def describe(self) -> str:
        parts = []
        for block in self.blocks():
            texts = []
            for segment in block.segments:
                duration, target = self.segment_text(segment)
                label = segment.label.replace("Recuperacao", "trote").replace("Longao Z2", "leve").lower()
                texts.append(f"{duration} {label}" if target == "livre" else f"{duration} em {target}")
            text = " + ".join(texts)
            parts.append(f"{block.repeat} × ({text})" if block.repeat > 1 else text)
        return " + ".join(parts)

    def to_dict(self) -> dict[str, object]:
        zone = self.zone
        intensity = {FIT_INTENSITY_WARMUP: "warmup", FIT_INTENSITY_COOLDOWN: "cooldown",
                     FIT_INTENSITY_RECOVERY: "recovery"}
        return {
            "meta": {"planner_version": PLANNER_VERSION, "manual": "PLANO_MARATONA_GARMIN.md"},
            "workout": {
                "kind": self.kind,
                "type": self.type.title,
                "name": self.name(),
                "day": self.day.isoformat(),
                "description": self.describe(),
                "file": f"{DEFAULT_CUSTOM_DIR.name}/{self.file_name()}",
                "pace": zone.target_pace,
                "pace_seconds_per_km": zone.target_seconds,
                "faster_pace": zone.faster_pace,
                "slower_pace": zone.slower_pace,
                "tolerance_seconds": zone.tolerance_seconds,
                "distance_km": json_number(self.measured_km()),
                "estimated_seconds": self.estimated_seconds(),
                "estimated_time": format_duration(self.estimated_seconds()),
                "fit_steps": len(self.fit_steps()),
                "blocks": [
                    {
                        "repeat": block.repeat,
                        "steps": [
                            {
                                "label": segment.label.replace("Recuperacao", "Recuperação (trote)"),
                                "duration": self.segment_text(segment)[0],
                                "target": segment.target,
                                "target_text": self.segment_text(segment)[1],
                                "intensity": intensity.get(segment.intensity, "active"),
                                "seconds": self.segment_seconds(segment),
                            }
                            for segment in block.segments
                        ],
                    }
                    for block in self.blocks()
                ],
            },
            "watch": {
                "model": self.watch.model,
                "line": self.watch.line,
                "exact_model": self.watch.exact_model,
                "paths": {"run_workout": self.watch.run_workout_path, "course": self.watch.course_path},
            },
        }

    def export(self, path: Path | None) -> Path:
        destination = (path or DEFAULT_CUSTOM_DIR / self.file_name()).expanduser().resolve()
        destination.parent.mkdir(parents=True, exist_ok=True)
        serial = int(datetime.now(timezone.utc).timestamp())
        destination.write_bytes(encode_fit_workout(self.name(), FIT_SPORT_RUNNING, FIT_SUB_SPORT_GENERIC,
                                                   self.fit_steps(), serial))
        return destination

    def render(self) -> str:
        return "\n".join([
            f"Treino avulso: {self.type.title} — {self.name()}",
            f"Relógio: {self.watch.model} (linha {self.watch.line})",
            f"Etapas: {self.describe()}",
            f"Pace alvo {self.zone.target_pace}, faixa {self.zone.faster_pace} a {self.zone.slower_pace} min/km.",
            f"Distância medida: {format_km(self.measured_km())}. "
            f"Tempo estimado: {format_duration(self.estimated_seconds())}.",
            "",
            "Para levar ao relógio: cabo USB → GARMIN\\NewFiles → desconectar.",
            f"No relógio: {self.watch.run_workout_path}.",
        ])


def read_config_file(path: Path) -> dict[str, object]:
    if not path.is_file():
        raise ValueError(f"Não encontrei o arquivo de configuração: {path}")
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"JSON inválido em {path}: {exc.msg}.") from exc
    if not isinstance(raw, dict):
        raise ValueError("O JSON de configuração precisa ser um objeto.")
    if "model" not in raw and "watch" in raw and "target" in raw:
        watch = raw["watch"]
        target = raw["target"]
        event = raw.get("event") if isinstance(raw.get("event"), dict) else {}
        training = raw.get("training") if isinstance(raw.get("training"), dict) else {}
        if not isinstance(watch, dict) or not isinstance(target, dict):
            raise ValueError("O JSON exportado precisa ter os objetos watch e target.")
        return {
            "model": watch.get("model", DEFAULTS["model"]),
            "distance_km": target.get("distance_km", DEFAULTS["distance_km"]),
            "pace": target.get("pace", DEFAULTS["pace"]),
            "race_date": event.get("date", DEFAULTS["race_date"]),
            "tolerance_seconds": target.get("tolerance_seconds", DEFAULTS["tolerance_seconds"]),
            "split_km": target.get("split_km", DEFAULTS["split_km"]),
            "event_name": event.get("name", DEFAULTS["event_name"]),
            "event_city": event.get("city", DEFAULTS["event_city"]),
            "current_long_km": training.get("current_long_km") or "",
            "plan_start": training.get("plan_start") or "",
        }
    unknown = sorted(set(raw) - ALLOWED_KEYS)
    if unknown:
        names = ", ".join(unknown)
        raise ValueError(f"Chave desconhecida no JSON: {names}.")
    return raw


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Planejador de maratona para relógios Garmin.",
        epilog=(
            "exemplos:\n"
            "  python garmin_marathon_planner.py\n"
            '  python garmin_marathon_planner.py --model "Venu 3" --pace 05:30 --distance 21.0975\n'
            "  python garmin_marathon_planner.py --config meu_alvo.json\n"
            "  python garmin_marathon_planner.py --fit --block-km 12\n"
            "  python garmin_marathon_planner.py --treinos\n"
            "  python garmin_marathon_planner.py --avulso ritmo --km 8 --pace 06:20\n"
            "  python garmin_marathon_planner.py --avulso tiros --tiros 6 --tiro-m 400 --recuperacao 90 --pace 05:30"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--model", help="Modelo do relógio. Padrão: Forerunner 165.")
    parser.add_argument("--distance", dest="distance_km", help="Distância alvo em km. Padrão: 42.195.")
    parser.add_argument("--pace", help="Pace alvo MM:SS por km. Padrão: 06:40.")
    parser.add_argument("--time", dest="finish_time", help="Tempo alvo H:MM:SS. Calcula o pace e substitui --pace.")
    parser.add_argument("--date", dest="race_date", help="Data da prova AAAA-MM-DD. Padrão: 2026-11-01.")
    parser.add_argument("--tolerance", dest="tolerance_seconds", help="Tolerância da zona em segundos. Padrão: 10.")
    parser.add_argument("--split-km", dest="split_km", help="Intervalo das parciais em km. Padrão: 5.")
    parser.add_argument("--event", dest="event_name", help="Nome da prova.")
    parser.add_argument("--city", dest="event_city", help="Cidade da prova.")
    parser.add_argument("--longao", dest="current_long_km",
                        help="Maior longão recente em km. O plano progride a partir dele.")
    parser.add_argument("--inicio", dest="plan_start",
                        help="Data de início do plano AAAA-MM-DD. Padrão: hoje. Até 16 semanas antes da prova.")
    parser.add_argument("--config", type=Path, help="JSON de entrada, plano ou exportado.")
    parser.add_argument("--output", type=Path, help="Caminho do JSON de saída.")
    parser.add_argument(
        "--fit",
        nargs="?",
        const=DEFAULT_FIT_OUTPUT,
        type=Path,
        help="Grava o treino de ritmo em .FIT para copiar em GARMIN/NewFiles. Padrão: treino_ritmo_maratona.fit.",
    )
    parser.add_argument(
        "--block-km",
        dest="block_km",
        default=DEFAULT_BLOCK_KM,
        help="Km do bloco no pace alvo dentro do .FIT. Padrão: 10.",
    )
    parser.add_argument(
        "--treinos",
        nargs="?",
        const=DEFAULT_TRAININGS_DIR,
        type=Path,
        help="Gera a pasta Treinos (semana, dia, treino-corrida, treino-forca) com os .FIT das semanas até a prova.",
    )
    parser.add_argument(
        "--json-only",
        action="store_true",
        help="Imprime o plano em JSON e não grava treino_maratona_config.json. Usado pela página web.",
    )
    custom = parser.add_argument_group(
        "treino avulso",
        "Gera um único treino de corrida .FIT. --pace e --tolerance viram o alvo do treino; --model escolhe o relógio.",
    )
    custom.add_argument("--avulso", dest="workout_kind", choices=list(WORKOUT_TYPES),
                        help="Tipo do treino: " + ", ".join(f"{k} ({v.title})" for k, v in WORKOUT_TYPES.items()) + ".")
    custom.add_argument("--km", help="Km do treino (pace, leve, ritmo e longao). Padrão: 8.")
    custom.add_argument("--aquecimento", help="Minutos de aquecimento. Padrão do tipo.")
    custom.add_argument("--desaquecimento", help="Minutos de desaquecimento. Padrão do tipo.")
    custom.add_argument("--tiros", help="Repetições do intervalado. Padrão: 6.")
    custom.add_argument("--tiro-m", dest="tiro_m", help="Metros de cada tiro. Padrão: 400.")
    custom.add_argument("--recuperacao", help="Segundos de trote entre os tiros. Padrão: 90.")
    custom.add_argument("--final-pace", dest="final_pace", help="Km finais no pace dentro do longão. Padrão: 0.")
    custom.add_argument("--dia", help="Data do treino AAAA-MM-DD, que abre o nome no relógio. Padrão: hoje.")
    custom.add_argument("--avulso-saida", dest="workout_output", type=Path,
                        help="Arquivo .fit de saída. Padrão: Treinos/avulsos/<data>_<treino>.fit.")
    return parser


def load_config(argv: list[str] | None = None) -> AppConfig:
    args = build_parser().parse_args(argv)
    data = dict(DEFAULTS)
    if args.config is not None:
        data.update(read_config_file(args.config))
    cli_values = {
        "model": args.model,
        "distance_km": args.distance_km,
        "pace": args.pace,
        "race_date": args.race_date,
        "tolerance_seconds": args.tolerance_seconds,
        "split_km": args.split_km,
        "event_name": args.event_name,
        "event_city": args.event_city,
        "current_long_km": args.current_long_km,
        "plan_start": args.plan_start,
    }
    for key, value in cli_values.items():
        if value is not None:
            data[key] = value
    output = args.output if args.output is not None else DEFAULT_OUTPUT
    return AppConfig(
        model=str(data["model"]),
        distance_km=data["distance_km"],
        pace=str(data["pace"]),
        race_date=str(data["race_date"]),
        tolerance_seconds=data["tolerance_seconds"],
        split_km=data["split_km"],
        event_name=str(data["event_name"]),
        event_city=str(data["event_city"]),
        output=output,
        fit_output=args.fit,
        block_km=args.block_km,
        trainings_dir=args.treinos,
        finish_time=args.finish_time,
        json_only=args.json_only,
        current_long_km=data["current_long_km"],
        plan_start=str(data["plan_start"] or ""),
        workout_kind=args.workout_kind,
        workout={
            "km": args.km, "warmup": args.aquecimento, "cooldown": args.desaquecimento, "reps": args.tiros,
            "rep_m": args.tiro_m, "recovery_s": args.recuperacao, "finish_km": args.final_pace, "day": args.dia,
        },
        workout_output=args.workout_output,
    )


def main(argv: list[str] | None = None) -> int:
    configure_stdio()
    try:
        config = load_config(argv)
        if config.workout_kind:
            workout = CustomWorkout.build(config)
            fit_path = workout.export(config.workout_output)
            if config.json_only:
                print(json.dumps(workout.to_dict(), ensure_ascii=False))
            else:
                print(workout.render())
                print(f"\nTreino .FIT: {fit_path}")
            return 0
        plan = MarathonPlan.build(config)
        fit_destination = None
        if config.fit_output is not None:
            block_km = parse_distance(config.block_km, "O bloco do treino")
            fit_destination = plan.export_fit_workout(config.fit_output, block_km)
        trainings = None
        if config.trainings_dir is not None:
            trainings = plan.export_training_tree(config.trainings_dir)
        if config.json_only:
            print(json.dumps(plan.to_dict(), ensure_ascii=False))
            return 0
        destination = plan.export(config.output)
    except ValueError as exc:
        print(f"Erro: {exc}", file=sys.stderr)
        return 2
    print(plan.render())
    print()
    print(f"Arquivo exportado: {destination}")
    if fit_destination is not None:
        print(f"Treino .FIT: {fit_destination}")
        print("Copie para o relógio pelo cabo USB, na pasta GARMIN\\NewFiles. A tela Importar dados do Garmin Connect não aceita treinos.")
    if trainings is not None:
        root, count = trainings
        print(f"Pasta de treinos: {root} ({count} arquivos .fit). Instruções em {root / 'README.md'}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
