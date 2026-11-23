# Componentes, identidade visual e licença

Este projeto é um pacote independente criado para a implementação solicitada. Reaproveitou-se somente a identidade visual autorizada — logo, avatar padrão e favicon — do arquivo visual indicado no briefing.

Assets visuais incluídos, sob allowlist verificada:

- `public/assets/logo-st-original.png`
- `public/assets/avatar-default.svg`
- `public/assets/favicon.svg`

Nenhum outro asset visual do arquivo de referência foi extraído ou incluído.

Dependências declaradas:

- `@whiskeysockets/baileys` `7.0.0-rc14` — MIT.
- `qrcode` `1.5.4` — MIT.

O lockfile foi derivado dos metadados versionados já existentes no arquivo de referência, sem inventar hashes, e validado offline. O empacotamento final exclui `node_modules`.

O perfil `public` contém o runtime e a documentação operacional; o perfil `source` inclui testes sintéticos e ferramentas de auditoria/empacotamento. Nenhum perfil inclui credenciais, banco, sessões, logs ou chaves privadas.

Meta, WhatsApp e marcas relacionadas pertencem aos respectivos titulares. Este pacote não declara homologação, afiliação ou garantia de disponibilidade dos serviços externos.
