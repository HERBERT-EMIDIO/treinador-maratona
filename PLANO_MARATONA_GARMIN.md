# Plano de Maratona Garmin — Maurício de Nassau

Prova: Maratona Maurício de Nassau, Recife, 01/11/2026. Distância: 42,195 km.
Recorde anterior: 4h50 (cerca de 6:52 min/km). Meta deste ciclo: pace constante de 6:40 min/km, perto de 4h41, do primeiro ao último quilômetro, sem andar.

O relógio de uso é o Garmin Forerunner 165. O manual e o script `garmin_marathon_planner.py` tratam esse modelo como padrão e aceitam outras linhas (Venu, Vívoactive, Fenix, Epix, Enduro, Instinct) e outras metas de pace ou distância. A fisiologia e a força estão neste arquivo. O script calcula parciais, zona de pace e a configuração de tela, e grava `treino_maratona_config.json`.

| Peça | Função |
| --- | --- |
| Este manual | Como operar cada linha, como ler sono, HRV e zonas, e como encaixar a força |
| `garmin_marathon_planner.py` | Cálculo e recomendação de tela para o modelo escolhido |
| `treino_maratona_config.json` | Saída do script, para consulta ou automação |

Os caminhos de menu abaixo seguem o manual do Forerunner 165 e da Venu 3. Um firmware pode mudar o nome de um item. A função estável é esta: na atividade, o botão de volta marca o quilômetro e avança a etapa do treino.

---

## Seção A — Manual multi-linha Garmin

### A.1 Montagem e transmissão de treinos no Garmin Connect

O treino nasce no telefone ou no navegador e chega ao relógio por Bluetooth. O relógio não precisa estar no cabo.

#### Criar o treino com alvo de ritmo

1. Abra o aplicativo Garmin Connect, ou entre em [connect.garmin.com](https://connect.garmin.com).
2. Vá em **Treino e planejamento → Treinos → Criar um treino**.
3. Escolha a atividade **Corrida**.
4. Monte as etapas. Para um treino de ritmo de maratona, um bloco útil é:
   - Aquecimento, 15 minutos, sem alvo de ritmo.
   - Corrida, distância do bloco (por exemplo 8 a 14 km neste ciclo), alvo **Ritmo**.
   - Desaquecimento, 10 minutos, sem alvo.
5. No alvo de ritmo, escolha a faixa personalizada. O número menor é o lado rápido.
   - Lado rápido: **6:30** min/km.
   - Lado lento: **6:50** min/km.
   - Centro da faixa, que é a meta: **6:40** min/km.
6. Salve e dê um nome que você reconheça no pulso, por exemplo `Maratona 6:40`.
7. Envie ao relógio: abra o treino, **Enviar para o dispositivo**, e escolha o relógio pareado.

O relógio vibra quando o ritmo sai da faixa. A faixa de 10 segundos para cada lado é larga o bastante para o GPS oscilar num viaduto e estreita o bastante para impedir um primeiro quilômetro em 6:10.

Para agendar, coloque o treino no calendário do Connect no dia certo. No sincronismo seguinte, o relógio mostra esse treino ao abrir a Corrida.

#### Transmitir por Bluetooth

1. Bluetooth do telefone ligado. O relógio precisa aparecer como conectado dentro do Garmin Connect, não só na lista de Bluetooth do sistema.
2. Deixe o aplicativo aberto, perto do relógio, até o envio concluir.
3. Confira no relógio, antes do dia do treino, se o nome do treino está na lista. Treino que não aparece no pulso não existe na hora da largada.
4. Se não chegar: atualize a tela do Connect, confirme o relógio selecionado e sincronize de novo. No Forerunner 165, segure **LIGHT** para abrir os controles e use **Sincronizar**, se o atalho estiver nesse menu.

#### Alternativa: arquivo .FIT pelo cabo USB

A tela **Importar dados** do Garmin Connect aceita só atividades já corridas (.fit, .tcx, .gpx). Arquivo de treino é recusado com "Um de seus arquivos não foi aceito pelo sistema". O treino em arquivo entra direto no relógio.

Para as semanas até a prova (até 16, a partir de hoje ou de `--inicio`; com `--longao` o longão parte do seu volume atual), `python garmin_marathon_planner.py --treinos` gera a pasta `Treinos/`, organizada em `semana-N/dia/treino-corrida` e `treino-forca`, com um `.fit` por sessão. O `Treinos/README.md` traz o quadro da semana e o passo a passo de cópia. Copie uma semana por vez.

Um treino avulso de ritmo:

1. Gere o arquivo: `python garmin_marathon_planner.py --fit` (bloco de 10 km) ou `--fit --block-km 12`. Sai `treino_ritmo_maratona.fit`, com aquecimento de 15 min, o bloco em 6:30–6:50 e desaquecimento de 10 min.
2. Ligue o relógio ao computador pelo cabo de carga. No Explorador de Arquivos ele aparece como dispositivo.
3. Abra **Armazenamento interno → GARMIN → NewFiles** e copie o `.fit` para lá.
4. Desconecte o cabo. O relógio processa o arquivo e o move para os treinos. Se não aparecer, reinicie o relógio.
5. Na corrida: **START → Corrida → UP → Treino → Treinos → Ritmo 06:40 10k**.

Esse treino fica só no relógio. Ele não aparece na lista de treinos do aplicativo Garmin Connect. Se você preferir o treino guardado na conta e agendado no calendário, monte-o no aplicativo pelos passos acima.

O mesmo arquivo de treino serve para qualquer relógio Garmin compatível com treinos estruturados. Trocar de Venu para Fenix não exige refazer a lógica do pace. Exige só um novo envio ao dispositivo e a forma de dar a partida, descrita na seção A.2.

#### O que usar no treino e o que usar na prova

| Momento | Ferramenta | Por quê |
| --- | --- | --- |
| Treinos de ritmo durante o ciclo | Treino estruturado com faixa 6:30–6:50 | O relógio cobra o bloco e você aprende a faixa |
| Longão com trechos no pace | O mesmo treino, no miolo da sessão | A faixa vira hábito antes de novembro |
| Dia da prova | PacePro em pace constante, ou alerta de faixa mais Auto Lap de 1 km | A prova é um pace só, sem etapas de aquecimento no meio da tela |

No Forerunner 165 o PacePro existe. Caminho no Connect: **Treino e planejamento → Estratégias de pace PacePro**. Crie por distância e pace, 42,195 km em 6:40, estratégia constante. Envie ao relógio. Na manhã da prova: **START → Corrida → segure UP → Treino → Planos PacePro → aceitar o plano → START**. A tela mostra o ritmo do trecho, o alvo e se o relógio acumulado está à frente ou atrás.

Auto Lap, em qualquer linha que tenha a função: segure o menu, **Atividades e aplicativos → Corrida → Voltas → Auto Lap → Por distância → 1,00 km**. Cada volta deve cair perto de 6:40. A tabela de 5 km do script é a auditoria, não a volta do relógio.

### A.2 Diferenças de interface e recursos

#### Linha Forerunner (165, 265, 965)

A linha é de corrida. O Forerunner 165, 265 e 965 têm tela de toque e cinco botões:

| Botão | Fora da atividade | Durante a corrida |
| --- | --- | --- |
| LIGHT | Liga a tela. Segurar abre os controles | Atalhos de controle |
| UP | Rola visões. Segurar abre o menu | Troca de tela. Na tela de largada, abre Treino e Navegação |
| DOWN | Rola visões | Troca de tela |
| START/STOP | Abre atividades e confirma | Dá a partida, pausa e confirma |
| BACK | Volta um nível | Marca a volta e avança a etapa do treino |

Partida de um treino estruturado no 165:

1. **START** e escolha **Corrida**. Espere a barra de GPS ficar pronta, ao ar livre.
2. **UP → Treino → Treinos** e escolha o treino.
3. **START → Fazer treino → START** para soltar o cronômetro.

Se o UP curto não abrir o menu na sua versão, segure UP. Os dois gestos aparecem no manual, conforme a tela.

O que muda dentro da linha:

| Recurso | Forerunner 165 | Forerunner 265 | Forerunner 965 |
| --- | --- | --- | --- |
| HRV Status, Body Battery, sono, VO2, tempo de recuperação | Sim | Sim | Sim |
| Training Effect e PacePro | Sim | Sim | Sim |
| Training Status e Training Readiness | Não | Sim | Sim |
| Teste guiado de limiar | Não | Sim | Sim |
| Navegação | Traçado do curso e TracBack | Traçado do curso (breadcrumb) | Mapa topográfico embarcado |
| ClimbPro e Stamina em tempo real | Não | Não | Sim |
| GPS multibanda | Não | Sim | Sim |

No 165, a manhã do longão usa quatro visões: **HRV Status**, **Body Battery**, **sono** e **tempo de recuperação**. O HRV precisa de cerca de três semanas dormindo com o relógio para mostrar status. A navegação do 165 desenha o curso e oferece volta ao início por **TracBack** ou em linha reta. Isso orienta um treino. Na Maurício de Nassau, a sinalização da prova é a referência. Deixe a tela de mapa fora do loop no dia 01/11.

Bateria declarada pela Garmin para o 165: cerca de 19 horas em GPS apenas, sem música, e cerca de 7 horas em GPS com música. Para uma prova perto de 5 horas, use GPS apenas e deixe a música desligada na versão Music. São números de fabricante, com carga cheia e GPS estável.

Tela de prova no 165:

1. Ritmo atual, ritmo da volta, distância, frequência cardíaca, cronômetro.
2. Ritmo médio e hora do dia.
3. PacePro no plano de 6:40, mais o alerta 6:30–6:50 como rede de segurança.

Na 265, a prontidão de treino passa a existir e entra na decisão da manhã junto com o HRV. Na 965, mapa, ClimbPro e Stamina existem. Em Recife, cidade e percurso predominantemente planos, esses três ficam fora da primeira tela. O que segura o 6:40 é ritmo, volta e frequência cardíaca.

#### Linha Venu e Vívoactive (Venu 3, Venu 4, Venu X1, Vívoactive 5, Vívoactive 6)

A Venu é um relógio de saúde com tela AMOLED e operação por toque. A Venu 3 tem três botões, com papéis diferentes dos cinco da Forerunner:

| Botão | Função |
| --- | --- |
| Action | Abre atividades. Segurar abre os controles |
| Back | Volta uma tela. Durante a atividade, marca a volta e avança a etapa do treino |
| Atalho / assistente | Atalho configurável. Segurar chama o assistente do telefone |

Não há um botão cujo nome seja Lap. A volta existe: é o Back, e só enquanto o cronômetro da atividade está valendo. A troca de telas é o deslize. Com chuva ou suor, o deslize falha mais do que um botão. Por isso a prova nesta linha usa uma tela só e Auto Lap de 1 km. O Back fica de reserva.

Partida de um treino na Venu 3:

1. Botão **Action** e toque em **Corrida**.
2. Abra **Treinos**, ou deslize até o **calendário de treino** se o treino estiver agendado para hoje.
3. Confira as etapas deslizando para cima.
4. Dê a partida pelo botão. Durante o bloco, o Back avança a etapa quando você quiser pular, e o alvo de ritmo da etapa continua valendo.

A Venu 3 traz HRV Status, Body Battery, sono, Sleep Coach e Training Status. ClimbPro, Stamina de endurance e mapa topográfico de trilha são recursos de Fenix, Epix e Forerunner 965. A decisão do longão na Venu 3 é HRV, sono, Body Battery e a perna. Não procure uma tela de Stamina.

A Vívoactive 5 é ainda mais centrada no toque e na bateria do dia a dia. O treino estruturado enviado pelo Connect funciona. A tela de prova é a mesma regra: um quadro com ritmo, distância, frequência cardíaca e cronômetro, Auto Lap de 1 km, alerta 6:30–6:50. Sono e Body Battery guiam a manhã. Confira no seu aparelho se o HRV Status está instalado antes de depender dele.

A Vívoactive 6 tem dois botões (START em cima, BACK embaixo) e toque. Tem HRV Status, Body Battery, PacePro e segue percurso, mas não tem Training Readiness nem Training Status: a decisão do longão usa a tabela de HRV e Body Battery da seção B. O BACK só marca volta se a Tecla de volta estiver ligada (configurações da Corrida → Voltas), então a prova fica no Auto Lap de 1 km. Treino: START → Atividades → Corrida → Treino → Biblioteca de treinos → Fazer treino. PacePro: START → Corrida → deslize para cima → Treino → Planos PacePro → Usar plano. Bateria declarada: até 21 h em GPS apenas. A Venu 4 e a Venu X1 acrescentam Training Readiness e Training Status; a X1 também traz mapa embarcado. Os caminhos e a ficha de cada modelo aparecem na aba Relógio do aplicativo.

Ensaie uma vez, num longão, com o braço molhado: pausar, retomar e ler o ritmo sem secar a tela.

#### Linha Fenix, Epix e Enduro

Esta linha é a de expediente longo: mapa topográfico offline, sensores de altitude, barômetro e bússola, e gestão fina de bateria.

Recursos que mudam uma prova em relação ao Forerunner 165:

| Recurso | Uso nesta maratona |
| --- | --- |
| Mapa topográfico offline | Útil para reconhecer o curso carregado. Na prova sinalizada, não é a tela principal |
| ClimbPro | Mostra subida à frente quando há um curso com relevo. Em percurso plano, fica fora do loop |
| Stamina em tempo real | Segunda tela. Estima a reserva que ainda cabe naquele esforço |
| Training Readiness e Training Status | Decisão da manhã, no lugar do conjunto reduzido do 165 |
| Modos de GPS | GPS apenas na maratona de rua. Multibanda e todos os sistemas ficam para cânion urbano ou trilha |
| Bloqueio de toque | Liga se chover. Os cinco botões continuam iguais aos da Forerunner |

A Epix é a variante AMOLED dessa família. O mapa fica mais nítido e a tela gasta mais. Bloquear o toque e usar GPS apenas devolve folga de bateria. A Enduro empurra a autonomia ainda mais. Uma maratona perto de 5 horas, em GPS apenas, termina com carga de sobra. Ainda assim, saia com 100%. Mapa colorido, multibanda e música ao mesmo tempo são o que encurta a estimativa.

Partida: a mesma lógica da Forerunner. **START → Corrida → UP → Treino**. PacePro, quando o modelo tiver, é a ferramenta de pace constante. Stamina na segunda tela responde a uma pergunta só: a reserva está caindo cedo demais para o quilômetro em que você está? Se aos 25 km a Stamina já foi embora e a frequência cardíaca entrou na zona 4, o pace vai para o lado lento da faixa, 6:50. Continua correndo.

#### Linha Instinct

A Instinct privilegia leitura no sol e autonomia. Há dois painéis na família, em modelos diferentes, não duas telas no mesmo relógio:

| Variante | Tela | Como ler a prova |
| --- | --- | --- |
| Instinct 2 e Instinct 3 Solar | MIP monocromático, alto contraste | Ritmo e distância grandes. O sol não apaga o número |
| Instinct 3 AMOLED | AMOLED colorida | Mesma lógica de campos. Evite brilho máximo o tempo todo |

A navegação é tática no sentido operacional: breadcrumb (a linha do curso sobre fundo simples), TracBack, rumo a um ponto e, nas edições táticas, coordenada em dois formatos na mesma tela, modo noturno e modo stealth. Stealth desliga armazenamento e compartilhamento de posição e a conectividade sem fio. No dia da prova ele fica desligado. Você precisa do GPS gravando.

Não há mapa topográfico colorido como na Fenix. Não conte com ClimbPro. A maratona nesta linha é duas telas:

1. Ritmo e distância.
2. Frequência cardíaca e cronômetro.

Auto Lap de 1 km e alerta 6:30–6:50 fecham a configuração. O contraste do MIP já resolve a leitura às 6 da manhã no sol de Recife, sem o custo de uma AMOLED no brilho alto.

---

## Seção B — Métricas, fisiologia e análise cardíaca

Estas leituras orientam o treino. Não diagnosticam doença. Sintoma fora do habitual (dor no peito, falta de ar desproporcional, tontura, palpitações em repouso) é assunto de médico, não de zona de pace.

### B.1 Métricas de recuperação e prontidão

#### Pontuação de sono (Sleep Score)

O Forerunner 165 acompanha o sono sozinho quando você dorme com ele, dentro do horário de sono configurado. A nota junta três blocos, visíveis com mais detalhe no Garmin Connect:

| Bloco | O que o relógio estima | Efeito no corredor |
| --- | --- | --- |
| Duração | Horas dormidas contra a necessidade do período | Poucas horas reduzem a reserva para o longão e para a termorregulação |
| Qualidade | Despertares, agitação, interrupções | Sono picado deixa a mesma carga mais cara no dia seguinte |
| Recuperação | Como a noite recarregou o sistema | É o pedaço que conversa com o HRV e com o Body Battery |

As fases no Connect são leve, profundo, REM e acordado. O profundo é a janela mais ligada à restauração física e ao hormônio do crescimento. O REM participa da regulação do sistema nervoso e da consolidação motora. O relógio estima isso pelo movimento e pela frequência cardíaca do punho. Não é um exame de polissonografia. Perseguir uma porcentagem exata de sono profundo, com a nota e a disposição boas, não muda o treino.

Faixas práticas da nota, como o Connect costuma classificar:

| Nota | Leitura | Efeito no longão de 6:40 |
| --- | --- | --- |
| 90–100 | Excelente | A faixa de pace está liberada, se a perna concordar |
| 80–89 | Boa | Pace alvo liberado |
| 60–79 | Razoável | Longão sai. O pace fica na metade lenta, 6:40 a 6:50, se o HRV não estiver baixo |
| Abaixo de 60 | Fraca | Dia de regenerar. Sem bloco em 6:40 |

O que mais move a nota neste ciclo é horário estável, tempo total e a ausência de álcool na véspera do longão. Álcool e jantar pesado tarde fragmentam o profundo e o REM e aparecem na manhã seguinte como nota pior e frequência de repouso mais alta.

#### Body Battery e HRV (VFC)

O Body Battery, no manual do 165, é uma reserva de 5 a 100. O relógio cruza variabilidade da frequência cardíaca, estresse, qualidade do sono e atividade. Não mede glicogênio e não mede dor muscular.

| Faixa oficial | Reserva |
| --- | --- |
| 76–100 | Alta |
| 51–75 | Média |
| 26–50 | Baixa |
| 5–25 | Muito baixa |

A leitura que importa é a da manhã, depois da recarga da noite. Um Body Battery alto com quadríceps dolorido depois de um treino forte significa que o sistema nervoso recarregou antes do músculo. Os dois entram na decisão. Um Body Battery baixo com pernas leves, depois de uma noite curta, pede redução de intensidade mesmo com a musculatura fresca.

O HRV Status do 165 compara a média de 7 dias da variabilidade noturna com a sua própria linha de base. Não compare o número em milissegundos com o de outro corredor. Os status do manual:

| Status | Significado |
| --- | --- |
| Equilibrado (Balanced) | A média de 7 dias está dentro da sua faixa |
| Desequilibrado (Unbalanced) | A média saiu da faixa, para cima ou para baixo |
| Baixo (Low) | A média está bem abaixo da sua faixa |
| Ruim (Poor) | Os valores estão bem abaixo do esperado para a idade |
| Sem status | Ainda não há três semanas de sono consistente |

Desequilibrado para cima também conta. Pode ser fadiga, calor acumulado, álcool, início de infecção ou um pico de estresse. Não é "HRV alto, então posso forçar".

**Regra da manhã do longão no Forerunner 165.** Training Readiness não existe neste modelo. A regra abaixo substitui essa tela.

| Manhã | Decisão |
| --- | --- |
| HRV equilibrado, Body Battery de 51 a 100, sono de 60 ou mais, tempo de recuperação baixo ou já cumprido, pernas normais | Longão com trechos em 6:40, dentro de 6:30–6:50 |
| HRV desequilibrado, ou Body Battery de 26 a 50, ou sono entre 60 e 79 | Corre o volume se não houver dor. O pace fica em 6:45–6:50, ou fácil, se a perna estiver pesada |
| HRV baixo ou ruim, ou Body Battery de 5 a 25, ou sono abaixo de 60, ou frequência de repouso vários bpm acima dos seus 7 dias | Regenera. Trote leve ou descanso. O 6:40 fica para outro dia |

O tempo de recuperação do 165 entra na mesma leitura. Se o relógio ainda pede muitas horas de recuperação na manhã do longão, trate o dia como a linha do meio da tabela, no mínimo.

Na Forerunner 265, 965 e na linha Fenix, o Training Readiness junta sono, HRV, carga aguda, histórico de sono e estresse num número só. Use-o junto com a tabela, não no lugar da sensação da perna. Na Venu 3, HRV Status e Training Status cobrem a semana. Na Instinct e na Vívoactive, use o que o modelo mostrar de sono e Body Battery e a mesma lógica: reserva baixa adia o pace, não a consistência do ciclo.

### B.2 Fisiologia de prova

#### VO2 máximo estimado

No 165, o VO2 máximo é o volume estimado de oxigênio, em ml/kg/min, no esforço máximo. Quem calcula é a Firstbeat, a partir da relação entre o pace (trabalho externo, via GPS) e a frequência cardíaca (custo interno), em corrida ao ar livre. O manual pede corrida de pelo menos 10 minutos, em intensidade moderada ou alta, alcançando pelo menos 70% da frequência cardíaca máxima, com o perfil e a FC máxima preenchidos. As primeiras estimativas oscilam. O relógio precisa de algumas corridas para aprender.

O número sobe quando você corre mais rápido na mesma frequência cardíaca, ou segura o mesmo pace com o coração mais baixo. Economia de corrida e condicionamento aparecem aí. O número cai, sem perda real de fôlego, quando:

- o calor e a umidade de Recife elevam a FC no mesmo pace (deriva cardíaca);
- a semana foi pesada e a FC de repouso subiu;
- o sono foi curto;
- a desidratação já começou no aquecimento;
- a corrida foi em trilha ou ultra e você deixou essa atividade alterar o VO2 (no 165 dá para desligar a gravação de VO2 nesses perfis).

Durante o ciclo, olhe a tendência de 4 a 6 semanas. Um ponto para baixo numa semana quente não cancela o treino. A previsão de prova do relógio, no visor de desempenho, usa esse VO2 e o histórico. Ela é uma referência. A meta combinada continua 6:40 se, nos treinos, esse pace cabe na zona 2 alta ou na zona 3 baixa. Se 6:40 já empurra a zona 4 em manhã fresca e descansada, o pace do ciclo recua para o lado lento da faixa até a FC caber. Terminar andando aos 32 km custa mais tempo do que largar em 6:48.

O medidor do 165 classifica a estimativa de superior a fraca, com tabelas do Cooper Institute por idade e sexo no manual. Use a classe como contexto. O pace da prova não sai dessa tabela.

#### Zonas de frequência cardíaca (Z1 a Z5)

O Forerunner 165 calcula as cinco zonas por porcentagem da FC máxima ou por porcentagem da reserva cardíaca (FC máxima menos FC de repouso). O caminho é: segure **UP → Perfil do usuário → FC e zonas de potência → Frequência cardíaca**. Informe a FC máxima real, se você a conhece. A fórmula 220 menos idade é só o padrão de fábrica. Em **Zonas → Baseado em**, escolha **%FC máxima** ou **%FCR**. Dá para ter zonas separadas para a corrida.

A tabela abaixo é a do manual Garmin para **% da FC máxima**:

| Zona | % da FC máxima | Sensação | Papel neste ciclo |
| --- | --- | --- | --- |
| Z1 | 50–60% | Solto, respiração ritmada | Regenerativo e volta à calma |
| Z2 | 60–70% | Confortável, conversa possível | Base e a maior parte dos longões |
| Z3 | 70–80% | Moderado, conversa em frases curtas | Teto do pace de prova. Miolo de treino em 6:40 quando a manhã permite |
| Z4 | 80–90% | Forte, respiração pesada | Limiar e intervalo. Não é pace de maratona |
| Z5 | 90–100% | Tiro, não sustentáveis | Fora da prova e fora do longão |

A **%FCR** aplica a lógica da reserva. Com FC de repouso baixa, estável no relógio, ela descreve melhor o corredor treinado do que a % da máxima sozinha. Enquanto a FC de repouso ainda não estabilizou, deixe em % da máxima e revise em duas ou três semanas. O teste guiado de limiar, que permitiria zonas por limiar de lactato, não faz parte do 165. Ele aparece na 265 e em linhas acima. Se no futuro o relógio passar a oferecer limiar, as zonas de corrida podem migrar para esse método. Até lá, a âncora é a tabela acima mais a fala.

**Estratégia para 6:40 sem andar.** O recorde de 4h50 está perto de 6:52 min/km. A meta de 6:40 é cerca de 12 s/km mais rápida, em torno de 3%, e cerca de 9 minutos no tempo final (4:41:18 no pace exato). É um passo que cabe num ciclo, desde que a intensidade interna não seja a de uma prova de 10 km.

| Fase | Pace na faixa | Frequência cardíaca | Objetivo |
| --- | --- | --- | --- |
| Até o km 5 | 6:40–6:45 | Z2, conversa em frases | Não comprar tempo no início. Largada rápida em umidade cobra depois do km 30 |
| Km 5 ao 30 | 6:40, oscilando 6:35–6:45 | Z2 alta ou Z3 baixa | Pace constante. Z4 só em ponta, posto ou viaduto, e volta |
| Km 30 ao 42,195 | 6:40 se a FC permitir; senão 6:45–6:50 | Teto: o topo da Z3 | Continuar correndo. 6:50 ainda é o plano. Andar não é |

A faixa do script é o registro dessa estratégia: 6:30 rápido, 6:40 alvo, 6:50 lento. O lado rápido existe para você ver o erro, não para ser o objetivo. Largar em 6:30 no calor de Recife é o caminho clássico para caminhar depois do km 30.

**Por que o colapso aparece depois do km 30.** Três mecanismos se somam, e a zona sozinha não cobre os três.

1. **Glicogênio.** Um esforço de mais de 4 horas esvazia a reserva muscular mesmo em Z2. Correr em Z2/Z3 baixa reduz o gasto de carboidrato por minuto. Não zera a conta. A reposição começa cedo: do km 5 ao 7, a cada 30–40 minutos, 30 a 60 g de carboidrato por hora, só com o gel e a bebida que você já usou nos longões. Quem já treinou o intestino pode ir além, dentro do que tolerou. Estrear produto no dia 01/11 é um motivo frequente de parar de correr sem que a perna tenha falhado.
2. **Calor e umidade.** Em Recife, mesmo fora do auge das chuvas, novembro continua quente e úmido. O suor evapora mal, a FC sobe no mesmo pace e a mesma velocidade migra de Z2 para Z3 e, se você insistir, para Z4. Isso é deriva, não falta de preparo. A resposta dentro do plano é beber nos postos no padrão dos longões, usar o sódio que você já tolerou e deixar o pace ir a 6:48–6:50 enquanto a FC volta ao topo da Z3. Andar para "recuperar" quebra o ritmo e, no calor, muitas vezes não devolve a FC. Abrir o pace 5 segundos devolve.
3. **Postura.** Com o glicogênio baixo e a temperatura alta, a cadência cai, a passada estica e o quadríceps e o sóleo passam a segurar o corpo em vez de empurrá-lo. O trabalho de força da seção C existe para atrasar esse momento. Se a forma quebrar, encurte a passada e mantenha o pace dentro da faixa. Não alongue a passada para "não perder tempo".

O teto operacional: FC estabelecida na Z4 antes do km 30, sem subida que explique, significa aliviar para 6:50 na hora. Z5 não tem função nesta prova. Z1 é o trote de regeneração e a volta à calma dos treinos.

Nos treinos, o longão não é 42 km em 6:40 toda semana. O pace alvo aparece em trechos no miolo, com a faixa do Connect ligada, e o restante do volume fica em Z2. É assim que o 6:40 continua sendo Z3 baixa em novembro, em vez de virar Z4 por falta de base.

---

## Seção C — Fortalecimento específico para a maratona

Duas sessões por semana, 30 a 40 minutos, sempre com 2 ou 3 repetições de reserva (pare antes da falha). Força pesada não vai na véspera do longão e não vai antes do treino de qualidade. No mesmo dia de um trote, corra primeiro e fortaleça depois. Na redução de 14 dias antes da prova, uma sessão, duas séries, os mesmos exercícios. Nos últimos 7 dias, só panturrilha leve e dead bug, sem carga nova.

O estímulo é sustentação. Recife pede que quadril, tronco e sóleo ainda funcionem quando a prova já passou de 3 horas e a temperatura subiu.

### C.1 Análise biomecânica

| Grupo | O que faz na corrida | O que falha depois do km 30 no calor |
| --- | --- | --- |
| Quadríceps | Aceita o peso na aterrissagem e segura o joelho no apoio | A passada afunda, o tempo de contato sobe e o pace só se mantém com mais FC |
| Glúteo máximo | Estende o quadril e empurra para trás | O tronco cai à frente e a propulsão passa para a panturrilha, que já está no limite |
| Glúteo médio | Mantém a pelve nivelada no apoio de uma perna só | O quadril do lado livre cai, o joelho roda para dentro e o trato iliotibial e o posterior reclamam |
| Posterior de coxa | Freia a perna no fim do balanço e ajuda a extensão do quadril | Câimbra e "perna que não responde" quando somam fadiga, calor e sódio mal testado |
| Gastrocnêmio | Flexão plantar com o joelho mais estendido, no fim da impulsão | Fatiga cedo por cruzar joelho e tornozelo. A passada fica barulhenta e vertical |
| Sóleo | Flexão plantar com o joelho flexionado. É o panturrilha de endurance | Quando o gastrocnêmio entrega, o sóleo é o que ainda devolve o chão. Sem ele, o km 35 vira arrasto |
| Core (abdominais, oblíquos, eretores, glúteo no tronco) | Trava o tronco para a força da perna virar deslocamento | No calor o tronco relaxa, a cadência cai e cada passo custa mais energia para o mesmo metro |

O trabalho pesado é lento e estável: descer a panturrilha em uns 3 segundos, joelho alinhado no afundo, pelve quieta no romeno unilateral. Pliometria nova neste ciclo, perto da prova, não entra. Quem já faz saltos há meses pode mantê-los longe do longão. Quem não faz, não começa em outubro.

### C.2 Rotina semanal integrada à corrida

Encaixe típico, ajustável à planilha de corrida que você já segue:

| Dia da estrutura | Corrida | Força |
| --- | --- | --- |
| Qualidade | Intervalo ou limiar, sem peso depois | Nenhuma |
| Dia seguinte | Leve, em Z1–Z2 | Sessão A |
| Meio da semana | Leve ou descanso | Nenhuma |
| Pelo menos 48 h antes do longão | Leve | Sessão B |
| Véspera do longão | Descanso ou trote bem leve | Nenhuma |
| Longão | Volume em Z2, com trechos na faixa 6:30–6:50 quando a manhã autorizar | Nenhuma |

Se a semana de corrida tiver outro desenho, a regra que não se move é: duas forças, nenhuma nas 24 horas antes do longão, nenhuma antes do treino de qualidade.

#### Sessão A — quadríceps, glúteo e tronco

| Exercício | Grupo | Volume | Execução |
| --- | --- | --- | --- |
| Agachamento goblet ou agachamento | Quadríceps e glúteo máximo | 3 x 6–8 | Desça até a coxa perto da horizontal, calcanhar no chão, 2–3 reps em reserva |
| Afundo reverso | Quadríceps, glúteo, controle excêntrico | 3 x 6–8 por perna | Passo para trás, joelho da frente estável, tronco alto |
| Ponte de glúteo ou hip thrust | Glúteo máximo | 3 x 8–10 | Pare 1 segundo no alto, lombar sem arquear |
| Caminhada lateral com mini band | Glúteo médio | 2 x 12 passos por lado | Joelho acompanha o pé, banda acima dos joelhos ou nos tornozelos |
| Prancha frontal | Core | 3 x 30–40 s | Costelas baixas, glúteo contraído |
| Prancha lateral | Oblíquo e glúteo médio | 2 x 20–30 s por lado | Quadril alto, corpo em uma linha |

#### Sessão B — posterior, panturrilha e core

| Exercício | Grupo | Volume | Execução |
| --- | --- | --- | --- |
| Levantamento terra romeno | Posterior de coxa e glúteo máximo | 3 x 6–8 | Coluna neutra, barra ou halter perto da coxa, sentir o posterior alongar |
| Romeno unilateral | Posterior e estabilidade da pelve | 3 x 6–8 por perna | Quadril do lado livre não abre, joelho de apoio macio |
| Panturrilha em pé | Gastrocnêmio | 3 x 10–12 | Joelho estendido, descer em 3 segundos, pausa embaixo |
| Panturrilha sentado | Sóleo | 3 x 12–15 | Joelho perto de 90 graus. Este é o exercício que não sai quando a sessão encolhe |
| Dead bug | Core, controle da lombar | 3 x 8 por lado | Lombar colada no chão o movimento inteiro |
| Bird dog | Core e glúteo | 2 x 8 por lado | Tronco quieto, sem rodar a pelve |

Progressão: suba a carga quando as 8 repetições terminarem com 4 ou mais em reserva. Na semana do longão mais pesado, mantenha a carga e corte uma série se a perna ainda estiver pesada na véspera. Não troque exercícios na quinzena da prova.

Se o tempo da sessão B acabar, a ordem do que fica é: panturrilha sentado, romeno, dead bug. Sóleo e tronco são o que ainda sustentam a postura quando o pace de 6:40 completa três horas no calor.

---

## Uso do planejador

Na pasta do projeto:

```text
python garmin_marathon_planner.py
```

Isso usa Forerunner 165, 42,195 km, pace 06:40, prova em 2026-11-01, faixa de 10 segundos e parciais de 5 km. O tempo do pace exato é 04:41:18. A faixa fica em 06:30 (04:34:16) e 06:50 (04:48:20). O arquivo `treino_maratona_config.json` é regravado ao lado do script.

Outra meta, outro relógio:

```text
python garmin_marathon_planner.py --model "Fenix 7" --pace 06:00 --distance 42.195
python garmin_marathon_planner.py --model "Venu 3" --pace 05:30 --distance 21.0975 --date 2026-11-01
python garmin_marathon_planner.py --config meu_alvo.json
python garmin_marathon_planner.py --time 4:30:00
```

`--time` recebe o tempo final (H:MM:SS) e calcula o pace, no lugar de `--pace`. `--longao 14` informa o maior longão das últimas quatro semanas e `--inicio 2026-12-06` fixa o começo do plano; o calendário escolhe o perfil pela distância (5 km, 10 km, meia ou maratona) e aceita prova em qualquer dia da semana. `--json-only` imprime o plano em JSON no terminal sem regravar o arquivo; é o modo que a página web usa.

Um JSON de entrada, com chaves planas, aceita `model`, `distance_km`, `pace`, `race_date`, `tolerance_seconds`, `split_km`, `event_name` e `event_city`. O JSON exportado também pode ser recarregado. Argumentos da linha de comando ganham do arquivo.

Para incluir um relógio novo, edite `LINE_PROFILES` (a família: botões, mapa, bateria) ou `MODEL_OVERRIDES` (o que aquele modelo tem a mais). Não é preciso outro script. Um nome como "Fenix 8" já herda a linha Fenix enquanto a ficha exclusiva não existe.

### Aplicativo no navegador

A página é estática: não precisa de PHP nem de Python instalado. Ela baixa o próprio `garmin_marathon_planner.py` e o roda dentro do navegador (Pyodide), então os números são sempre os do script. Localmente, abra `http://localhost/treinador_maratona/` com o Apache do XAMPP ligado. Para outra pessoa usar, publique a pasta no GitHub Pages (passos abaixo) e mande o link. A primeira abertura baixa cerca de 10 MB do motor; depois o navegador guarda em cache.

| Aba | Para quê |
| --- | --- |
| Hoje | Contagem para a prova, treino do dia, próximo treino e km da semana |
| Montar treino | Assistente de um treino avulso em quatro passos: relógio, treino de hoje (tipo, km, pace e faixa), percurso no mapa e download do `.fit` com o passo a passo do modelo escolhido. Detalhes em "Montar treino: do app ao relógio", abaixo |
| Treinador IA | Conversa com o Gemini usando a chave grátis da própria pessoa (aistudio.google.com/apikey, guardada só no navegador). A IA pergunta, explica e propõe a meta; o botão "Aplicar ao plano" passa a proposta ao planejador, que recalcula plano, parciais e `.fit` |
| Semanas | Até 16 semanas com a fase de cada uma (construção, recuperação, pico, polimento, prova), dia a dia, etapas, força, "Marcar como feito", download do `.fit` do dia e da semana inteira em `.zip`, sempre com a meta atual |
| Calculadora | Relógio, distância, pace ou tempo alvo, faixa e parciais; nome, cidade e data da prova, início do plano e maior longão recente; recalcula ao digitar |
| Mapa | Alfinete de início, caminho clicando no mapa (segue ruas a pé) e alfinete de chegada; local de início e de chegada preenchidos pelo endereço ou digitados com Enter; paradas marcadas com alfinete no caminho, com nome, km e hora prevista no pace; Desfazer e Refazer (Ctrl+Z e Ctrl+Y); fecha volta ou ida e volta, salva no navegador e baixa GPX com os alfinetes |
| Relógio | Configuração de telas e alertas do modelo escolhido |
| Manual | Este arquivo |

O GPX vai para o relógio como percurso: Garmin Connect, Treino e planejamento, Percursos, Importar, salvar e "Enviar para o dispositivo". No relógio, o percurso aparece em Corrida, Navegação, Percursos. Os treinos `.fit` continuam indo pelo cabo USB para `GARMIN\NewFiles`.

Marcações de "feito", meta e percursos salvos ficam só no navegador de cada pessoa (localStorage). O mapa precisa de internet (OpenStreetMap e roteamento a pé).

### Montar treino: do app ao relógio

A aba **Montar treino** cria um treino de corrida fora do plano, para o dia que você quiser. O resumo ao lado mostra as etapas, a distância e o tempo estimado, calculados pelo script a cada mudança.

1. **Relógio.** Escolha o modelo na grade ou digite outro e aperte Enter. O nome do treino, os menus do passo a passo e a escolha valem também para o resto do app.
2. **Treino de hoje.** Escolha o tipo, o dia, a distância, o pace e a faixa (± segundos). Os botões − e + mudam meio km ou 5 s por toque. "Pace da prova" copia o pace da meta.
3. **Percurso (opcional).** "Desenhar no mapa" abre o Mapa já com o treino como alvo: o painel mostra quanto falta e as parciais no pace do treino. "Usar no treino", no Mapa, ou "Usar distância do mapa", no assistente, copia a distância do percurso para o treino.
4. **Levar para o relógio.** Baixe o `.fit` e siga o passo a passo da tela, que usa os menus do modelo escolhido.

| Tipo | Etapas no relógio | Alerta |
| --- | --- | --- |
| Corrida no pace | Distância inteira na faixa | Pace |
| Rodagem leve | Distância inteira na zona 2 | Frequência cardíaca. O pace informado só estima o tempo |
| Ritmo | Aquecimento (15 min), bloco no pace, desaquecimento (10 min) | Pace no bloco |
| Intervalado | Aquecimento, N × (tiro em metros no pace + trote por tempo), desaquecimento | Pace nos tiros. O relógio conta as repetições |
| Longão | Zona 2 e, se quiser, os km finais no pace; 5 min de desaquecimento | FC no trecho leve, pace no final |

Aquecimento e desaquecimento de cada tipo podem ser trocados (0 a 20 min). Etapas por tempo e por distância avançam sozinhas no relógio.

**Do computador para o relógio**

1. Ligue o relógio ao computador pelo cabo de carga.
2. Windows: Explorador de Arquivos → nome do relógio → Armazenamento interno → `GARMIN` → `NewFiles`. Mac: o relógio costuma não aparecer no Finder; use um app de transferência MTP, como o OpenMTP (grátis).
3. Copie o arquivo `.fit` solto (sem pasta e sem `.zip`) para `NewFiles` e desconecte o cabo.
4. No relógio, abra a lista de treinos da atividade Corrida:

| Linha | Caminho |
| --- | --- |
| Forerunner | START → Corrida → UP → Treino → Treinos → treino do dia |
| Vívoactive | START → Atividades → Corrida → role para baixo → Treino → Biblioteca de treinos → treino → Fazer treino → START |
| Venu | Botão de cima → Corrida → role para baixo → Treino → Biblioteca de treinos → treino → Fazer treino |
| Fenix, Epix, Enduro | START → Corrida → segure MENU → Treino → Treinos → treino → Fazer treino |
| Instinct | GPS (START) → Corrida → segure MENU → Treino → Treinos → treino → Fazer treino |

O nome do treino começa pela data (`13out Ritmo8k`), porque o relógio mostra só os 15 primeiros caracteres. Pelo cabo, o treino fica só no relógio: a tela "Importar dados" do Garmin Connect e o app do celular não aceitam treinos. Apague os antigos na lista de treinos do relógio.

O percurso do mapa vai separado, como GPX: Garmin Connect → Treinamento e planejamento → Percursos → Importar → "Enviar para o dispositivo".

Pela linha de comando, o mesmo treino sai com `--avulso`:

```text
python garmin_marathon_planner.py --avulso ritmo --km 8 --pace 06:20
python garmin_marathon_planner.py --avulso tiros --tiros 6 --tiro-m 400 --recuperacao 90 --pace 05:30 --model "Vivoactive 6"
python garmin_marathon_planner.py --avulso longao --km 18 --final-pace 4 --pace 06:40
```

Os tipos são `pace`, `leve`, `ritmo`, `tiros` e `longao`. `--aquecimento` e `--desaquecimento` (minutos), `--dia` (AAAA-MM-DD) e `--avulso-saida` completam. O arquivo vai para `Treinos/avulsos/`.

Publicar no GitHub Pages (grátis, repositório público), na pasta do projeto:

```text
gh auth login --web
gh repo create treinador-maratona --public --source . --push
gh api -X POST repos/{owner}/treinador-maratona/pages -f "source[branch]=main" -f "source[path]=/"
```

Em um ou dois minutos o site fica em `https://SEU-USUARIO.github.io/treinador-maratona/`. Depois de mudar o script ou o manual, `git add -A`, `git commit -m "..."` e `git push` atualizam o site. A pasta `Treinos/` não vai para o GitHub; o navegador gera os arquivos.
