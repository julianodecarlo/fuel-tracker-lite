# Fuel Tracker — Plano de produção (roteiro para o Claude Code)

> Como usar: copie este arquivo para a raiz do repositório (ou cole no Claude Code no VS Code) e peça:
> "Execute a Fase 1 deste plano, uma tarefa por vez, rodando `npm test` ao fim de cada uma e me mostrando o diff antes de seguir."
> Os números de linha abaixo vêm de uma auditoria feita em 05/11/2026 e podem ter mudado. Confirme lendo o código.

## Contexto (não alterar)

- App web local-first empacotado com **Capacitor 8** (pasta `android/`), interface em português, dados em `localStorage`.
- `applicationId`: `io.github.julianodecarlo.twa`. **Não renomear** (já publicado na Play).
- Produto único PRO: ID **`fuel_tracker_pro`** (R$ 4,90, compra única). O ID `fuel-tracker-pro` é o da *opção de compra* e **não** é usado no código.
- Plano Lite: limite de lançamentos (constante `LITE_RECORD_LIMIT`), aba Análise, Excel, múltiplos veículos e configurações de manutenção são exclusivos do PRO.
- Plugin de cobrança escolhido: **`cordova-plugin-purchase`** com o adaptador Capacitor **`capacitor-plugin-cdv-purchase`** (usa Play Billing Library 8.x; a Play não aceita mais a versão 7).
- **Nunca** commitar `signing.keystore`, `signing-key-info.txt` ou senhas. Verifique o `.gitignore`.

## Fase 1 — Obrigatória antes da produção

### 1.1 Remover o modo de teste e o menu Dev
- `TRIAL_FORCE_PRO` está `true` em `billing.js` (~linha 40) e em `app.js` (~linha 398). Colocar `false` nos dois, ou melhor, ter uma única fonte da verdade.
- Remover do HTML e do `app.js` o menu/botão **"Dev: Lite/Pro"** (`toggleDevPlan` e relacionados, ~linha 2378).
- `isDev()` hoje é baseado em `hostname === 'localhost'`, que é **verdadeiro dentro do app Capacitor** (`https://localhost`). Substituir por uma flag de build explícita (padrão: produção). Em produção, `init()`/`refresh()` da cobrança **devem** rodar.
- Adicionar um teste em `tests/` que **falha** se `TRIAL_FORCE_PRO` for `true` ou se existir o menu Dev no HTML.
- **Aceite:** instalado no aparelho, nenhum menu Dev aparece e um usuário Lite não consegue virar PRO sem comprar.

### 1.2 Cobrança nativa (substituir a Digital Goods API)
- `billing.js` usa `getDigitalGoodsService` (~linha 155), que só existe em TWA no Chrome e **não** funciona no WebView do Capacitor.
- Instalar `cordova-plugin-purchase` e `capacitor-plugin-cdv-purchase`, rodar `npx cap sync android`. Seguir a documentação da versão instalada (não assumir API de memória).
- Fluxo esperado (confirmar nomes na documentação): registrar `fuel_tracker_pro` como **NON_CONSUMABLE** na plataforma Google Play, inicializar a loja, tratar a transação aprovada, **finalizar/confirmar (acknowledge)** a compra, e consultar os produtos possuídos (`owned`).
- Regras de licença:
  - PRO = a loja informa que `fuel_tracker_pro` pertence ao usuário. Reconsultar **a cada abertura e ao voltar do segundo plano**.
  - Cache local da licença só como apoio offline, com **prazo máximo sem revalidação** (padrão sugerido: 14 dias; confirmar com o dono do projeto).
  - **Reembolso:** se a loja deixar de listar o produto, revogar o PRO.
  - Botão **"Restaurar compra"** visível na tela de upgrade.
  - Compra feita por **código promocional** resgatado na Play Store deve aparecer como produto possuído. Cobrir isso no fluxo de consulta.
  - Fora do app nativo (versão web/PWA no GitHub Pages), esconder a compra e mostrar texto orientando a baixar o app.
- Manter a camada de verificação **plugável** (função `verifyLicense(purchase)`), pois a Fase 2 pode acrescentar validação em servidor.
- Atualizar `tests/billing.test.js` com mocks do novo plugin. Manter os 14 testes existentes passando ou migrados.
- **Aceite:** compra, cancelamento no meio, reinstalação, aparelho novo (mesma conta) e reembolso funcionam em conta de testador de licença.

### 1.3 Backup que funcione no app instalado
- `downloadBlob()` e `XLSX.writeFile()` (~linha 1526) dependem de `<a download>` com Blob, que o WebView do Capacitor em geral não trata.
- Instalar `@capacitor/filesystem` e `@capacitor/share`. No app nativo: gravar o arquivo (backup JSON e Excel) e oferecer **salvar em Downloads/Documentos** e **compartilhar**. Fora do nativo, manter o download atual.
- Se o plugin não gravar direto em Downloads no Android atual, salvar em Documentos e abrir a folha de compartilhamento. Informar ao usuário o local exato do arquivo na mensagem de sucesso.
- Só mostrar "Backup gerado com sucesso" **depois** de confirmar a gravação.
- Registrar a data do último backup e mostrar lembrete após 30 dias.
- **Aceite:** em aparelho real, o arquivo existe, abre e é restaurável pelo fluxo de importação.

### 1.4 Ajustes de acabamento e segurança
- "Indicar para Amigo": compartilhar o link da Play Store (`https://play.google.com/store/apps/details?id=io.github.julianodecarlo.twa`), não `window.location.href` (vira `https://localhost` no app).
- Remover `diagnostico.html` do build de produção.
- `www/`: é gerado por `scripts/copy-web.js` (`npm run build:web`). Adicionar ao `.gitignore` e gerar sempre antes do build. Hoje os ícones de `www/` divergem dos da raiz.
- Remover a permissão `INTERNET` **somente se** a Fase 2 não for usada e nada mais precisar dela.
- Avaliar `android:dataExtractionRules`/`fullBackupContent` para controlar o que o backup automático do Android restaura.
- Adicionar testes para `core.js` (cálculo de km/L, validação de registros, limites do Lite).

### 1.5 Versão e build
- Aumentar `versionCode` (hoje 4) e `versionName` em `android/app/build.gradle`.
- Sequência: `npm test` → `npm run build:web` → `npx cap sync android` → Android Studio: **Build → Generate Signed App Bundle** com o keystore `signing.keystore`, alias `my-key-alias`.
- A impressão digital do keystore (SHA-256) coincide com a chave de upload cadastrada na Play. Se o upload for recusado por assinatura, parar e avisar.

## Fase 2 — Verificação em servidor (decisão do dono: opção C = Cloudflare Worker + Play Integrity)

**Só começar depois que a Fase 1 estiver testada em aparelho real.** Desenho:

- **Servidor:** Cloudflare Worker (plano gratuito: 100 mil requisições/dia e 10 ms de CPU por requisição; esperar de rede não conta). Como 10 ms é pouco para criptografia, fazer **cache do token de acesso do Google** (KV ou memória) e não assinar JWT a cada chamada.
- **O app envia:** `purchaseToken` + token de integridade. O *nonce* do token de integridade deve ser amarrado ao `purchaseToken` e a um desafio do servidor (evita reaproveitamento).
- **O Worker faz:**
  1. Valida a compra na Google Play Developer API (produto `fuel_tracker_pro`; comprado; não reembolsado nem cancelado).
  2. Decodifica o token na API Play Integrity (`decodeIntegrityToken`) exigindo `appRecognitionVerdict = PLAY_RECOGNIZED` e `appLicensingVerdict = LICENSED`. O veredito de dispositivo (`MEETS_DEVICE_INTEGRITY`) deve ser critério **suave** (aparelhos com ROM personalizada ou root não devem perder o PRO que pagaram; confirmar a política com o dono).
  3. Confere pacote, certificado e nonce.
  4. Devolve uma **licença assinada** com validade (sugestão: 14 dias). O app guarda a licença e valida a assinatura com uma chave pública embutida.
- **Volume:** pedir o token de integridade só na compra, na restauração e na revalidação periódica, **não a cada abertura** (cota padrão: 10 mil tokens/dia por projeto Google Cloud).
- **Plugin no app:** `@capacitor-community/play-integrity`. Verificar compatibilidade com Capacitor 8 e se está mantido; se não servir, escrever um pequeno plugin nativo com a biblioteca Play Integrity.
- **Segredos:** a conta de serviço do Google fica apenas como secret do Worker. Nunca no repositório nem no app.
- **Falhas:** erro de rede ou do servidor **nunca** revoga o PRO; vale a licença em cache até o prazo dela.
- **Privacidade:** o token de compra sai do aparelho. Atualizar o formulário **Segurança dos dados** e a política de privacidade. O Worker não deve guardar dados pessoais nem registrar tokens em log.
- **Pré-requisitos do dono (Console):** vincular um projeto Google Cloud em Play Console → Protegido com o Google Play → API Play Integrity; criar a conta de serviço e conceder acesso à API do Play Console para consultar compras.

## Plano de testes em aparelho real (Teste interno + contas de testador de licença)

1. Instalar pela faixa de Teste interno com uma conta de testador de licença.
2. Lite: limite de lançamentos, aba Análise, Excel e veículos bloqueados; modal de upgrade abre.
3. Compra com "cartão de teste, sempre aprova" → PRO liberado; a compra foi confirmada (sem estorno automático após 3 minutos).
4. Cancelar a compra no meio → continua Lite.
5. Desinstalar e reinstalar → PRO volta ao abrir (com internet).
6. Aparelho novo, mesma conta → PRO volta.
7. Sem internet, dentro do prazo do cache → PRO funciona. Fora do prazo → comportamento definido.
8. Reembolso (pelo Console) → PRO é revogado.
9. **Um** código promocional resgatado na Play Store → PRO liberado.
10. Backup: exportar JSON e Excel, localizar o arquivo, importar de volta.
11. "Limpar armazenamento" do app → dados somem; restaurar pelo backup funciona.
12. Atualização por cima de uma versão antiga (dados existentes preservados).

## Só depois: produção
Liberação gradual (sugestão: 20%), acompanhar travamentos e avaliações por alguns dias, depois ampliar.
