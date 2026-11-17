# QA exploratório: consulta ao maestro e replicação para colegas

## O que a integração usa

**Sim, o Munder Difflin participa como ponte local**, mesmo quando orquestrador e
executor rodam no OpenCode fora do Munder. O bot é a identidade no Slack; o código
do Munder é quem envia, recebe callbacks, correlaciona as threads e entrega eventos.
Os prompts sozinhos não substituem essa ponte.

```text
Executor de QA / orquestrador
  → ferramenta de projeto md_slack_consult, helper CLI ou MCP md-slack-consult
  → endpoint autenticado, somente local, do Munder
  → Slack: bot publica no canal configurado
  → assistente responde na mesma thread
  → callback público do Slack → Munder verifica assinatura/remetente/canal/thread
  → notificação à sessão do executor e à sessão do orquestrador
```

No modo validado, o Munder menciona o grupo, reconhece a saudação configurada e
envia a pergunta na mesma thread. Não é preciso repetir a menção na segunda
mensagem nesse fluxo. Outro assistente pode ser configurado para receber menção
e pergunta juntas. IDs, remetente permitido, saudação e prazo ficam na configuração,
não no código nem nos prompts de QA.

Na validação ao vivo, o helper foi chamado pela sessão OpenCode, não por um agente
da interface do Munder. O Munder enviou pelo bot já instalado e recebeu o callback.
As atualizações `sent`, `question_sent` e `received` chegaram à sessão do
orquestrador por `opencode api post /api/session/{id}/prompt`, com `delivery: steer`.
Foi usada a mesma sessão como executor/orquestrador nessa checagem; a entrega a
destinatários distintos foi coberta pelos testes locais. O ciclo levou cerca de
1min42s, com uma pergunta e sem duplicidade. Não houve execução de ações no ERP.

## Quando e como perguntar no teste exploratório

Consulte para destravar uma dúvida nova de fluxo, conceito, pré-condição ou resultado
ambíguo. Reutilize respostas confirmadas; não consulte a cada clique nem para erros
técnicos de CDP/screenshot. A política canônica está em `.demandas/REGRAS_QA.md`,
seção 2.1, no projeto ERP. Não é necessário adicionar campos ao formulário inicial.

- **context:** demanda/cenário e módulo/tela, de forma curta.
- **question:** objetivo, tela atual real, condições decisivas, observação e uma
  pergunta principal; peça resposta breve com passos/precondições e fonte.
- Use nomes reais da tela e campos; informe consulta versus lançamento e aba/modal
  quando isso fizer diferença. Versão, parâmetro, período, pagamento e tipo de
  movimento entram somente quando conhecidos e relacionados à dúvida.
- Marque o que veio do critério/massa e o que foi observado. Se a tela ainda não
  abriu, informe a tela alvo, sem inventar estado atual.
- Não envie credenciais, dados reais de clientes, dumps, código/log integral ou
  o STATE completo. Não faça investigação extra apenas para preencher o contexto.

Exemplo de conteúdo, não de comando a executar:

```text
context: QA <demanda>/04 · Financeiro/Outras Entradas
question:
Objetivo: receber uma fatura em dinheiro e estornar pela UI.
Tela atual: Outras Entradas — lançamento da Tesouraria Central.
Observado: a confirmação informa que Repasse de Fatura está desabilitado;
nenhum movimento foi criado.
Dúvida: esse parâmetro é pré-condição e em qual tela posso verificá-lo?
Informe brevemente o caminho e a fonte, sem executar alterações.
```

O executor registra o ID da consulta e aguarda eventos, não faz polling do Slack
nem repete a pergunta por demora. Orquestrador e executor recebem as atualizações
quando seus destinatários foram informados corretamente. A resposta integral fica
na ponte; no STATE, guarde só ID, síntese, fonte, aplicabilidade e pendência.

Orientação não é autorização de escrita nem evidência de teste. Confirme o estado
e comportamento na aplicação. Se a resposta não resolver a dúvida, identifique a
lacuna para o orquestrador antes de outra consulta, respeitando o tempo global.

## Replicar em outra máquina — opção disponível hoje

### Descoberta no OpenCode do ERP

O projeto ERP tem um adaptador em `.opencode/tools/md_slack_consult.ts`, registrado
por `.opencode/plugins/project-tools.ts`. Ele usa o cliente local
`.opencode/tools/lib/md_slack_bridge.cjs` e o helper já existente `lib/define_tool.ts`.
Não é um registro MCP e não requer outro bot. No Code Mode, procure a ferramenta
pelo nome no catálogo antes de concluir que ela não existe.

```json
{ "action": "probe" }
```

Essa checagem autentica uma leitura do broker local e **não publica no Slack**.
Ela não comprova a configuração do assistente nem uma resposta ponta a ponta.
Faça-a uma vez na preparação, não por cenário. Uma consulta real usa:

```json
{
  "action": "ask",
  "context": "QA <demanda>/<cenário> · <módulo/tela>",
  "question": "Objetivo, tela e observação relevante. Qual é o próximo passo seguro?"
}
```

O adaptador lê os metadados da sessão atual e da sessão pai para notificar executor
e orquestrador. Se o orquestrador real não for o pai direto, forneça o
`orchestratorSessionID` real obtido do host. Na sessão principal, sem pai, os dois
destinatários são a própria sessão. Permissões do host continuam valendo.

Para recuperar, use `action: "status"` ou `action: "retry_notifications"` e
`consultationId` retornado; não repita a pergunta automaticamente após timeout.
A resposta da ferramenta é compacta; o registro integral permanece no Munder.

**Nenhum critério precisa testar Slack.** O maestro é apoio consultivo ao teste
do ERP, não um cenário extra obrigatório. Se a ferramenta ainda não aparecer em
uma sessão já aberta, recarregue o projeto/serviço após preservar o trabalho em
andamento. Enquanto isso, o helper CLI de caminho confirmado pode ser usado;
ausência de MCP não equivale a ausência da ponte.

1. **Distribua a versão com esta implementação.** As alterações desta sessão são
   locais até serem compartilhadas/versionadas. Instalar apenas uma versão upstream
   que não contém a funcionalidade ou copiar só os prompts não basta. Use um build
   da versão alterada ou, a partir do repositório completo, instale as dependências
   e execute `npm run typecheck`, `npm run build` e `npm run preview`. Siga também
   os pré-requisitos de instalação do README do projeto.
2. **Use uma Slack App/bot própria por instalação**, aprovada para o workspace.
   Configure o bot token e signing secret dessa aplicação na interface local do
   Munder. Não compartilhe sua configuração pessoal nem credenciais com colegas.
3. Inicie a conexão Slack no Munder do colega e configure a URL pública de callback
   exibida na aplicação em **Event Subscriptions → Request URL** da Slack App dele.
   Se a URL do túnel mudar, atualize-a. O Munder e o callback devem ficar acessíveis
   enquanto a consulta estiver pendente.
4. Convide o bot dele ao canal do maestro. Permita `chat:write` e a assinatura de
   `message.channels`/`channels:history` para canal público ou
   `message.groups`/`groups:history` para privado. Só `app_mention` não recebe
   necessariamente a resposta sem menção na thread. Após alterar permissões,
   reinstale/reautorize o app se o Slack solicitar. Confirme que o assistente aceita
   perguntas originadas por esse bot; não libere indiscriminadamente todos os bots.
5. Em **Settings → Connections → Slack → External assistant consultations**, habilite
   a função e preencha canal, ID da menção, remetente permitido, modo de conversa,
   trecho da saudação quando aplicável (sem diferenciar maiúsculas/minúsculas) e prazo. S… identifica grupo: o remetente é o
   ID real do usuário/bot/app que responde, não todos os membros do grupo. Os IDs
   podem ser os mesmos do canal/assistente compartilhados, desde que autorizados
   nesse workspace; continuam sendo dados de configuração, não código.
6. Instale/configure o OpenCode no computador que executa a ponte, se esse for o
   destino. O comando `opencode` precisa estar no PATH do Munder. Reutilize os três
   arquivos `.demandas/REGRAS_QA.md`, `PROMPT_ORQUESTRADOR.md` e `PROMPT_SUBAGENT.md`
   e o template HTML no projeto do colega. Não copie STATEs ou consultas de outra
   pessoa como se fossem o estado da execução dele.
7. Disponibilize o helper ao orquestrador por caminho absoluto ou registre seu modo
   `--mcp` no host do colega. Alternativamente, copie os arquivos do adaptador de
   projeto descritos acima e integre seu registro ao plugin existente, preservando
   as demais ferramentas. O adaptador vive no ERP, não é instalado automaticamente
   pelo build do Munder. O registro MCP também não acontece por copiar o script.
   Com CLI/MCP, o orquestrador fornece os **IDs reais das sessões dele** e seus projetos;
   não reutilize IDs da sua sessão. Em agentes do Hive, use os destinatários locais
   de agente. Os comandos e flags estão no [guia técnico](slack-assistant-consultations.md).
8. Com autorização, faça uma consulta curta não sensível e confira as três partes:
   mensagem no canal/thread, resposta do remetente esperado e notificação admitida
   na sessão correta. Uma resposta no Slack sem atualização no orquestrador não é
   validação ponta a ponta. Não execute operações financeiras para testar a ponte.

**Não copie** `config.json` completo, `slack-reply.json`, tokens/signing secrets ou
`slack-consultations.json` entre pessoas. O arquivo de descoberta contém uma
capacidade de acesso ao broker local; o histórico contém perguntas e respostas.

### Por que não configurar o mesmo bot em todos os computadores?

Uma Slack App tem uma URL de eventos configurada. Se colegas apontarem a mesma
aplicação para túneis diferentes, trocarão o destino dos callbacks uns dos outros;
as respostas e os IDs das sessões deixarão de corresponder à instalação correta.
Compartilhar o token não resolve o roteamento e aumenta o risco de exposição.

Para compartilhar **um único bot e uma única ponte** com toda a equipe, seria preciso
centralizar a recepção e adicionar autenticação por usuário/dispositivo e entrega
segura ao OpenCode de cada máquina. Isso **não foi implementado nesta versão**:
o broker é restrito ao loopback, e `opencode api` usa o serviço local da máquina
do Munder. Não exponha o endpoint `/reply`/`/consultations` nem seu arquivo de
capacidade no túnel para contornar essa limitação. Hoje, a implantação independente
por colega é o caminho já suportado.

## Diagnóstico rápido

- “Ferramenta não encontrada”: procurar `md_slack_consult` no catálogo/Code Mode,
  verificar carregamento do plugin de projeto ou usar o CLI de caminho confirmado.
  Não instalar outro bot nem criar um teste de Slack por esse motivo.
- `probe` falha: verificar Munder aberto, conexão Slack e versão com consultas.
  Não abrir nem copiar o arquivo de descoberta para o contexto do agente; ele
  contém a credencial local usada internamente pelo adaptador.
- `not_in_channel`: convidar o bot emissor ao canal correto.
- `missing_scope`: revisar a permissão específica e reautorizar o app; não repetir
  envios. Permissões de consulta de identidade são opcionais quando os IDs são conhecidos.
- Há saudação, mas não há pergunta: conferir modo e trecho configurado da saudação.
- Há resposta no Slack, mas não na sessão: conferir callback, assinatura/eventos,
  remetente permitido, sessões/projetos reais e PATH do OpenCode. Inspecionar
  `--status <id>` local; após corrigir a entrega, usar `--retry-notifications <id>`.
- `timed_out`/`delivery_unknown`: não postar de novo automaticamente. Verificar a
  consulta existente; respostas tardias continuam correlacionadas dentro da retenção.
