# Limitações e gates da versão 0.1.0

Data da revisão: 2026-11-22

## Verificado offline

- **55/55 testes sintéticos aprovados**, exit `0`, em 24 arquivos de teste.
- Login com sessão, CSRF, `Origin`, logout, limite de tentativas e resposta `Retry-After`.
- Isolamento de tenant por identificadores forjados e por status WABA de outra conta.
- Cadastro de empresa/administrador e cadastro/ativação explícita de conta WABA.
- HMAC do webhook sobre corpo original, deduplicação, persistência antes do ACK, rejeição de payload com contas misturadas e receipts de campanha.
- Isolamento de mensagem/destinatário de campanha por conta WABA no webhook.
- Upload XLSX sintético, teto configurável de destinatários, entidades XML, payload privado e não criação automática de contatos.
- Campanha com conta WABA explícita, modelo/parâmetros, iniciar/pausar/retomar/cancelar e preservação de receipts.
- Recuperação de destinatário interrompido como `uncertain`, sem reenvio.
- Timeout de entrega mantido como `uncertain`; rejeição determinística mantida como `failed`.
- Claim atômico, lease/fence, ACK obsoleto, lease vencido, idempotência de eventos e rejeição de SQL livre.
- Supervisor QR aguardando prontidão, sem segundo motor no mesmo processo.
- Sintaxe de 48 arquivos `.mjs` e de `public/app.js`, sem falhas.
- Lockfile coerente, com 125 pacotes, validado offline com exit `0`.
- Empacotamento `public` e `source` com sidecar, hashes, assets visuais allowlisted, exclusões verificadas e ausência de sobrescrita.
- Validação em Chromium real, com dados sintéticos, em viewports de 1440×900 e 360×800: login, instalação local, upload XLSX, campanha local `pending_agent`, Campanhas e Conexões; sem overflow horizontal, erro HTTP, exceção ou mensagem de console.
- Lighthouse no painel validado com notas 1,00 em Acessibilidade, Best Practices e SEO.
- Revisão independente somente leitura concluída; achados aplicáveis foram corrigidos e cobertos por testes.

## Gates externos bloqueados

- Dependências Baileys/QR não foram instaladas nem obtidas pela rede. O motor QR exige `npm ci` e setup explícito em ambiente autorizado.
- Nenhuma credencial Meta real, WABA real, sessão QR real, número de telefone real ou template real foi usado.
- Meta Graph API `v23.0`, envio real, callbacks e templates aprovados não foram validados contra a API real.
- QR não foi pareado, escaneado nem submetido a desconexão/recuperação real.
- O limite de 5.000 destinatários é uma política configurável, não resultado de carga.
- O limite de `CAMP_MAX_IN_FLIGHT` é por processo; implantações com múltiplas instâncias exigem coordenação externa.
- OCI/Hostinger não foram provisionados nem medidos; não há certificado de deploy, certificado TLS ou prova de persistência no provedor.
- Não houve teste com carga, saturação, disco cheio, queda de energia, restauração real ou firewall do provedor.

## Omissões funcionais explícitas

- Não há cadastro automático de contatos.
- Não há catálogo, funil, relatórios, IA, anexos ou GDPR completo.
- Não há migração do app instalado nem compatibilidade prometida com suas sessões QR.
- Não há agente local completo; o Web publica o contrato v1 para um cliente separado.
- Não há interface de gestão de usuários, troca de senha, recuperação de senha ou rotação de `APP_ENCRYPTION_KEY`.
- Não há auditoria administrativa imutável.
- Não há entrega de campanha QR Web pelo executor Web; o QR permanece em fase de integração de canal.
- Não há política de retry para destinatários `failed` ou `uncertain`; o Web não reenvia automaticamente.
- Pausar/cancelar não cancela uma requisição WABA que já está em voo.
- O cursor de paginação do gateway usa ID; inserções concorrentes durante paginação longa exigem avaliação específica no cliente.
- O rate limit de login é local ao processo e não compartilhado entre instâncias.
- Não há tela detalhada de receipts de campanha; a API os expõe por `GET /api/campaigns/:id`.
- Não há interface administrativa para redefinir uma sessão QR `new_pairing_required`; essa operação exige procedimento operacional fora do MVP.

Não remova estes avisos sem uma verificação correspondente e evidência em ambiente autorizado.
