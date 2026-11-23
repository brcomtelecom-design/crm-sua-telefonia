# Sua Telefonia CRM Web Node

Aplicação Web de atendimento e campanhas para **Sua Telefonia**, construída de forma isolada com Node.js, SQLite nativo, HTTP nativo e módulos próprios.

A versão `0.1.0` é um **MVP operacional**, não uma certificação de produção. O pacote permite executar login multiempresa, atendimento, contratos WABA, campanhas leves, gateway local e supervisor QR. Porém, **nenhuma conta WABA real, sessão QR real, chamada Meta real, hospedagem ou capacidade sob carga foi validada** durante a preparação.

## Perfis de entrega

| Perfil | Conteúdo | Uso |
|---|---|---|
| `public` | Runtime, interface, lockfile, documentação e backup; exclui testes e ferramentas internas de empacotamento. | Implantação no servidor. |
| `source` | Inclui o perfil público, testes sintéticos e ferramentas de empacotamento/verificação. | Auditoria e reprodução offline. |

O artefato público previsto é:

```text
SUA_TELEFONIA_CRM_WEB_NODE_0.1.0.zip
SUA_TELEFONIA_CRM_WEB_NODE_0.1.0.zip.manifest.json
```

O pacote fonte é entregue separadamente, com a raiz `SUA_TELEFONIA_CRM_WEB_NODE_SOURCE` e sidecar próprio. Cada ZIP inclui um sidecar com SHA-256 por arquivo e do arquivo ZIP.

## Recursos implementados

- Login com `scrypt`, cookie `HttpOnly`, sessão persistida, expiração, CSRF e proteção por `Origin`.
- Limite local de cinco falhas de login por par origem/e-mail, `Retry-After` e reset do contador após sucesso.
- Isolamento por empresa em recursos e permissões administrativas para criar empresa/administrador.
- Atendimento Web com conversas, histórico e intenção de resposta idempotente; uma repetição não executa um segundo envio ao provedor.
- Cadastro protegido de contas WABA, com `Phone Number ID`, `WABA ID`, access token e app secret criptografados em repouso.
- Ativação explícita de conta WABA; campanhas Web exigem uma conta WABA ativa selecionada, sem fallback automático.
- Webhook WABA em `GET/POST /api/meta/webhook`:
  - desafio de verificação com `META_VERIFY_TOKEN`;
  - HMAC SHA-256 sobre o **corpo original**;
  - identificação da conta por `phone_number_id`;
  - deduplicação;
  - persistência antes do ACK;
  - rejeição de payload assinado que misture contas;
  - atualização de status isolada por conta;
  - eventos repetidos não duplicam mensagens.
- Upload temporário e privado de XLSX, com limite de destinatários configurável, validação de telefone/CPF, payload criptografado e cleanup com contenção de caminho.
- Campanhas Web duráveis por destinatário, com conta WABA explícita, modelo aprovado, parâmetros, iniciar/pausar/retomar/cancelar e receipts preservados.
- Sem cadastro automático de contatos e sem reaproveitamento automático de um envio cujo resultado ficou incerto.
- Destinatários interrompidos em `sending` são recuperados como `uncertain`, com receipt `PROCESS_RESTARTED`, sem reenvio.
- Gateway Web → agente local v1 com `claim` atômico, `leaseId`, `fence`, ACK, recuperação de lease vencido e eventos idempotentes.
- Comandos locais allowlisted: `query_audience`, `create_campaign`, `start_campaign`, `pause_campaign`, `cancel_campaign`; SQL livre é rejeitado.
- QR Web em processo separado, sessão por conta fora do webroot e canal IPC privado; **desabilitado até setup explícito**.

## Requisitos

- Node.js `>=22.16.0` (validação local: `v24.22.0`).
- Sistema com suporte a `node:sqlite`.
- Em produção, HTTPS no proxy.
- Para QR: `npm ci` concluído e `QR_ENABLED=true` somente após revisão da persistência.

## Instalação

```bash
unzip SUA_TELEFONIA_CRM_WEB_NODE_0.1.0.zip
cd SUA_TELEFONIA_CRM_WEB_NODE
cp .env.example .env
npm ci --omit=dev
npm start
```

O comando `npm ci` **não foi executado durante a preparação deste pacote**, por decisão de não instalar dependências de rede nesta etapa. O `package-lock.json` foi validado offline com:

```bash
npm install --package-lock-only --ignore-scripts --offline --no-audit --no-fund
```

O restante do servidor não importa Baileys/qrcode em tempo de inicialização; o motor QR exige as dependências declaradas em `package.json`.

### QR Web — setup explícito

1. Copie `.env.example` para `.env`.
2. Gere uma chave de criptografia de 32 bytes:

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

3. Preencha todas as variáveis e defina `QR_ENABLED=true` somente após `npm ci` e revisão de persistência.
4. Reinicie o serviço e use **Conexões → Cadastrar conta QR Web → Conectar → Exibir QR**.
5. Pareie em ambiente autorizado. O QR expira em aproximadamente 60 segundos e não deve ser compartilhado fora do fluxo operacional.

`QR_AUTH_DIR` deve ser persistente, privado e ficar fora do webroot. Uma instalação Local do WhatsApp não pode reutilizar o mesmo diretório de sessão do app instalado. Códigos terminais `401`, `403` ou `440` deixam a sessão em `new_pairing_required` e não autorizam reuso automático.

## Variáveis de ambiente

Use `.env.example` como lista canônica. Não use senha ou segredo padrão.

| Variável | Finalidade |
|---|---|
| `HOST` | Interface de bind do Node. Em proxy local, normalmente `127.0.0.1`. |
| `PORT` | Porta HTTP. O proxy deve encaminhar para esta porta. |
| `NODE_ENV` | `production` na hospedagem. |
| `BASE_URL` | URL pública HTTPS, sem query/fragmento. |
| `WEBSITE_ORIGIN` | Origem exata usada na proteção CSRF/Origin. |
| `DB_PATH` | Arquivo SQLite persistente fora do build/webroot. |
| `TEMP_CAMPAIGN_DIR` | Área privada temporária de uploads XLSX. |
| `QR_AUTH_DIR` | Área privada persistente das sessões QR. |
| `BACKUP_DIR` | Diretório de backups; opcional, com padrão ao lado do banco. |
| `ADMIN_EMAIL` | Administrador inicial. |
| `ADMIN_PASSWORD` | Senha inicial; mínimo de 12 caracteres. |
| `APP_ENCRYPTION_KEY` | 64 caracteres hexadecimais (32 bytes) ou base64 de 32 bytes. |
| `META_APP_ID` | Identificador operacional do aplicativo Meta. |
| `META_APP_SECRET` | Segredo global de fallback para contas sem app secret específico. |
| `META_VERIFY_TOKEN` | Token global do desafio do webhook. |
| `CAMP_MAX_RECIPIENTS` | Teto configurável, de 1 a 5.000. **5.000 é política segura, não capacidade comprovada.** |
| `CAMP_MAX_IN_FLIGHT` | Limite global de destinatários em voo, de 1 a 20. |
| `QR_ENABLED` | `false` por padrão; habilite somente após o setup. |

Contas WABA são cadastradas em **Conexões**, por administrador autenticado. Access tokens e app secrets são criptografados com `APP_ENCRYPTION_KEY` e nunca são devolvidos pela API. O token do desafio é global (`META_VERIFY_TOKEN`); não há token de desafio por conta no formulário.

## Operação

```bash
NODE_ENV=production npm start
```

O processo escuta em `HOST:PORT`. Verifique:

```bash
curl http://127.0.0.1:PORT/api/health
```

Não há fallback automático de canal. Se WABA/QR estiver offline, a interface mostra offline/pendente e uma campanha não troca de conta por conta própria.

### Permissões administrativas

Somente `admin` pode:

- cadastrar empresa e administrador;
- cadastrar/ativar conta WABA;
- cadastrar/conectar conta QR;
- gerar token de instalação local.

Operadores podem consultar recursos da própria empresa, atender e trabalhar com campanhas permitidas.

## Campanhas Web

O upload aceita XLSX com aliases de cabeçalho em português/inglês. O fluxo Web exige:

- uma conta WABA ativa explicitamente;
- `templateName` aprovado;
- `parameters` como lista de valores, quando o modelo exigir;
- `opt_in_at`, `opt_in_source` e `opt_in_evidence` para cada destinatário que possa ser enviado.

Sem evidência de consentimento, o destinatário termina como `failed` com `CONSENT_REQUIRED`; ele não é enviado. O template usa `pt_BR` nesta versão.

Estados duráveis por destinatário incluem `pending`, `sending`, `sent`, `delivered`, `read`, `failed`, `cancelled` e `uncertain`. Cancelar não apaga receipts. Pausar impede novas picks, mas não cancela envios que já estavam em voo. Retomar uma campanha sem pendências a encerra como `completed` sem reenvio.

O executor Web usa uma fila global e `CAMP_MAX_IN_FLIGHT`; não há worker por campanha. Campanhas grandes permanecem no app local por meio do gateway.

## Webhook WABA

URL exata, derivada de `BASE_URL`:

```text
GET  /api/meta/webhook
POST /api/meta/webhook
```

O `GET` valida `hub.mode=subscribe`, `hub.verify_token` contra `META_VERIFY_TOKEN` e devolve `hub.challenge`. O `POST` exige `X-Hub-Signature-256`; a assinatura é calculada sobre os bytes originais recebidos, usando o app secret da conta identificada.

Configure no proxy:

- sem cache;
- sem desafio HTML/Cloudflare na rota;
- preservação do corpo e do cabeçalho de assinatura;
- `client_max_body_size` compatível com o limite de 1 MiB;
- timeout suficiente para persistência, sem retry agressivo do proxy.

A implementação referencia `graph.facebook.com/v23.0`; a compatibilidade dessa versão, do template e dos payloads com a Graph API real não foi validada nesta etapa.

## Gateway do agente local — contrato v1

O Web expõe:

```text
GET  /api/agent/v1/commands?after=&limit=
POST /api/agent/v1/commands/:id/claim
POST /api/agent/v1/commands/:id/ack
POST /api/agent/v1/events
```

Autenticação: `Authorization: Bearer <token-da-instalação>`. O token resolve uma instalação e seu tenant; o cliente não escolhe tenant no corpo.

- `claim` exige `leaseId` e `fence`; a claim é atômica e incrementa o fence.
- `ack` exige o mesmo `leaseId` e o fence vigente.
- Lease vencido retorna o comando à fila preservando o fence; ACK do lease antigo é rejeitado.
- `events` exige `eventKey`, `type` e `payload`; repetição idêntica é idempotente, conteúdo diferente com a mesma chave é conflito.
- O payload de audiência usa filtros allowlisted; SQL livre é rejeitado.
- `create_campaign`, `start_campaign`, `pause_campaign` e `cancel_campaign` não exigem `conversation_id`.

O cliente do agente é uma implementação separada e deve persistir a intenção local antes de executar o canal.

## Backup e recuperação

O estado durável de campanhas está no banco. O backup abaixo usa a API de backup do SQLite, evitando copiar apenas o arquivo principal enquanto o WAL está ativo:

```bash
DB_PATH=/home/crm/data/crm.sqlite BACKUP_DIR=/home/crm/backups npm run backup
```

Guarde também `APP_ENCRYPTION_KEY` separadamente e, se quiser preservar o pareamento sem novo login, uma cópia consistente de `QR_AUTH_DIR`. Uploads temporários não são necessários para restaurar o estado durável das campanhas.

Para restaurar:

1. pare a aplicação;
2. preserve o diretório atual;
3. copie o backup validado para `DB_PATH`;
4. restaure `QR_AUTH_DIR`, se aplicável, do mesmo ponto de restauração;
5. restaure a chave em cofre de segredos;
6. inicie e confira `/api/health`, login, contas e histórico.

O backup script não inclui sessões QR nem a chave de criptografia.

## Hostinger

1. Crie um projeto Node.js e uma porta privada fornecida pelo provedor.
2. Defina `HOST=127.0.0.1` e `PORT` conforme a porta atribuída.
3. Crie diretórios persistentes fora de `public_html`, por exemplo `/home/crm/data/{db,temp,qr}`.
4. Use `NODE_ENV=production`, copie as variáveis de `.env.example` e preencha todos os segredos.
5. Instale com `npm ci --omit=dev` e configure o start como `npm start`.
6. Configure proxy HTTPS para `http://127.0.0.1:PORT`; não exponha a porta Node diretamente.
7. Restrinja permissões: diretórios de dados/sessões somente para o usuário do app; `.env` com permissão privativa.

A disponibilidade de processos e a sustentação de CPU/memória da Hostinger **não foram comprovadas**.

## OCI ARM/x86

O código não impõe arquitetura. Em uma VM Ubuntu ARM64 ou x86_64:

```bash
node --version
npm ci --omit=dev
NODE_ENV=production npm start
```

Para contêiner, monte `DB_PATH`, `TEMP_CAMPAIGN_DIR` e `QR_AUTH_DIR` em volume persistente, monte o `.env` como secret e exponha somente `PORT`. Não copie sessões QR do host para dentro da imagem.

O suporte a imagem OCI específica **não foi construído nem validado** neste pacote; valide `npm ci` e o supervisor QR na arquitetura-alvo antes do piloto.

## Reverse proxy e Cloudflare

- Use TLS Full (strict), não Flexible.
- Encaminhe `Host`, `X-Forwarded-Proto` e o corpo sem recompressão que altere os bytes.
- Não aplique cache à API nem ao webhook.
- Não coloque autenticação/desafio HTML na rota do webhook.
- Restrinja métodos no proxy quando possível e preserve `Authorization`.
- Evite CAPTCHA/interstitial no webhook; se o provedor exigir, use uma rota específica e documente a exceção.

## Empacotamento e verificação

No pacote de fonte:

```bash
node scripts/package.mjs public D:/SUA_TELEFONIA_CRM_WEB_NODE_0.1.0.zip
node scripts/verify-package.mjs D:/SUA_TELEFONIA_CRM_WEB_NODE_0.1.0.zip public

node scripts/package.mjs source D:/pacote-fonte.zip
node scripts/verify-package.mjs D:/pacote-fonte.zip source
```

O empacotador aborta se o ZIP ou sidecar já existir. Ambos os perfis excluem `.env` real, bancos, logs, `node_modules`, sessões, uploads temporários e chaves privadas. O perfil público exclui ainda `tests/**` e as ferramentas internas de empacotamento.

Os únicos assets visuais extraídos são:

```text
public/assets/logo-st-original.png
public/assets/avatar-default.svg
public/assets/favicon.svg
```

## Testes e gates

```bash
npm test
node --check public/app.js
npm install --package-lock-only --ignore-scripts --offline --no-audit --no-fund
```

Na revisão de 2026-11-22:

- suíte sintética offline: **55/55 testes, exit `0`**;
- arquivos `.mjs`: **48 verificados, 0 falhas**;
- frontend: `public/app.js` sintaticamente válido;
- lockfile: **125 pacotes**, coerente com `package.json` e validado offline com exit `0`;
- navegador Chromium: login sintético, instalação local, upload XLSX e campanha local `pending_agent` validados em **1440×900** e **360×800**, sem overflow horizontal, exceções, erros HTTP ou mensagens de console;
- Lighthouse no painel validado: **Acessibilidade 1,00**, **Best Practices 1,00** e **SEO 1,00**;
- revisão independente somente leitura concluída; achados aplicáveis de executor, guarda de conversa e regra de packaging foram corrigidos e cobertos por testes.

Os testes usam banco temporário, servidor em `127.0.0.1` com porta aleatória, dados sintéticos e mocks offline. A validação de navegador também usou dados sintéticos; nenhum teste ou fluxo chamou Meta/WhatsApp real, pareou QR ou configurou credenciais externas.

## Limitações

Consulte `LIMITACOES.md`. Os principais gates externos são: `npm ci` em ambiente autorizado, pareamento QR real, credenciais/conta/template WABA reais, homologação Graph API, medição de carga e certificação de hospedagem.


## Publicação do código-fonte no GitHub

Este repositório contém o código-fonte do MVP para avaliação e colaboração.
Não envie arquivos `.env`, bancos de dados, backups, logs, sessões QR, chaves privadas nem dados de clientes.
Antes de disponibilizar o projeto para contribuições open source, o proprietário deve decidir uma licença e verificar os direitos de uso dos materiais de marca e imagens.
**Até que uma licença seja adicionada, a disponibilização pública não concede automaticamente permissão para reutilizar, modificar ou distribuir o código.**

### Como executar localmente

1. Instale Node.js >=22.16.0.
2. Execute `npm ci` para instalar dependências.
3. Copie `.env.example` para `.env` e configure credenciais próprias; nunca publique o `.env`.
4. Execute `npm test` e depois `npm start`.

Não use credenciais ou contas reais para testes sem revisar antes as limitações em `LIMITACOES.md`.


## Licença

Este projeto é distribuído sob a licença MIT. Consulte o arquivo [LICENSE](LICENSE) para conhecer os termos de uso, modificação e distribuição.
