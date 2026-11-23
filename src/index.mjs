import { loadConfig } from './config.mjs';
import { createApplication } from './server.mjs';

const config = loadConfig();
const application = await createApplication(config);
application.server.listen(config.port, config.host, () => {
  console.info(`Sua Telefonia CRM Web Node ouvindo em http://${config.host}:${config.port}`);
  console.info(`Ambiente: ${config.nodeEnv}; QR Web: ${config.qrEnabled ? 'habilitado' : 'desabilitado'}`);
});

async function shutdown(signal) {
  console.info(`Recebido ${signal}; encerrando de forma controlada.`);
  try {
    await application.close();
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
