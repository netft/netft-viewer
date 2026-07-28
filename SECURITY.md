# Security Policy

## Supported versions

Security fixes are provided for the latest published release.

| Version | Supported |
| --- | --- |
| 0.1.x | Yes |
| Older releases | No |

## Report a vulnerability

Use GitHub's private vulnerability reporting for `netft/netft-viewer`: open the repository **Security** tab, select **Advisories**, and choose **Report a vulnerability**. Do not open a public issue or pull request before maintainers have assessed the report.

Include the affected version and platform, the security boundary involved, reproducible steps or a minimal proof of concept, the expected impact, and any suggested mitigation. Remove sensor addresses, private network details, recordings, credentials, signing material, and personal data.

Maintainers will acknowledge a complete report as soon as practical, coordinate validation and remediation privately, and credit reporters who want attribution. Please allow time for supported-platform packages and release assets to be prepared before public disclosure.

## Security boundaries

The renderer is sandboxed and communicates with the native companion only through a narrow preload API and validated protocol. Packaged release assets are checksumed, accompanied by an SBOM, uploaded to a draft, downloaded for byte comparison, and published only through a protected environment.

Sensor HTTP configuration and UDP RDT traffic are unauthenticated. This project does not make those protocols secure. Operate sensors on a trusted, access-controlled network and do not expose them directly to the public internet.
