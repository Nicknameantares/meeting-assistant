// GigaChat API certificates are issued by the Russian Trusted Root CA, which Android
// does not trust by default. This trusts it only for Sber's API domains.
// The certificate is fetched and checked by fingerprint during the CI build
// (see .github/workflows/android-apk.yml) and is not kept in the repository.
const fs = require('fs');
const path = require('path');
const { withAndroidManifest, withDangerousMod } = require('expo/config-plugins');

const CERT = 'certs/russian_trusted_root_ca.pem';

const NETWORK_CONFIG = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <domain-config>
    <domain includeSubdomains="true">devices.sberbank.ru</domain>
    <trust-anchors>
      <certificates src="system" />
      <certificates src="@raw/russian_trusted_root_ca" />
    </trust-anchors>
  </domain-config>
</network-security-config>
`;

module.exports = function withRussianTrustedCA(config) {
  config = withDangerousMod(config, [
    'android',
    (cfg) => {
      const root = cfg.modRequest.projectRoot;
      const cert = path.join(root, CERT);
      if (!fs.existsSync(cert)) {
        console.warn(`[withRussianTrustedCA] ${CERT} not found: GigaChat requests will fail TLS checks.`);
        return cfg;
      }
      const res = path.join(cfg.modRequest.platformProjectRoot, 'app/src/main/res');
      fs.mkdirSync(path.join(res, 'raw'), { recursive: true });
      fs.mkdirSync(path.join(res, 'xml'), { recursive: true });
      fs.copyFileSync(cert, path.join(res, 'raw/russian_trusted_root_ca.pem'));
      fs.writeFileSync(path.join(res, 'xml/network_security_config.xml'), NETWORK_CONFIG);
      return cfg;
    },
  ]);
  return withAndroidManifest(config, (cfg) => {
    if (fs.existsSync(path.join(cfg.modRequest.projectRoot, CERT))) {
      cfg.modResults.manifest.application[0].$['android:networkSecurityConfig'] = '@xml/network_security_config';
    }
    return cfg;
  });
};
