#!/bin/sh
# Starts the test domain: a new authority and server certificate, the
# domain CORP.EXAMPLE provisioned with them, then samba in the foreground.
# The authority is written to /out once the domain controller answers.
set -eu

out=/out
mkdir -p /certs "$out"
rm -f "$out/ca.pem"

cd /certs
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=Nether test domain authority" \
  -keyout ca.key -out ca.pem 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj "/CN=localhost" \
  -keyout server.key -out server.csr 2>/dev/null
printf 'subjectAltName=DNS:localhost,DNS:dc1.corp.example,IP:127.0.0.1,IP:::1\n' > server.ext
openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 2 \
  -extfile server.ext -out server.pem 2>/dev/null
chmod 600 server.key ca.key

rm -f /etc/samba/smb.conf
samba-tool domain provision --realm=CORP.EXAMPLE --domain=CORP --server-role=dc \
  --dns-backend=SAMBA_INTERNAL --adminpass="${AD_ADMIN_PASSWORD:-Admin-Passw0rd-1}" \
  --option="tls enabled = yes" \
  --option="tls keyfile = /certs/server.key" \
  --option="tls certfile = /certs/server.pem" \
  --option="tls cafile = /certs/ca.pem" > /tmp/provision.log 2>&1 \
  || { cat /tmp/provision.log; exit 1; }

# The authority, once the domain controller answers on ldaps://.
(
  for _ in $(seq 1 120); do
    if openssl s_client -connect 127.0.0.1:636 -CAfile /certs/ca.pem </dev/null >/dev/null 2>&1; then
      cp /certs/ca.pem "$out/ca.pem"
      echo "The test domain is ready"
      exit 0
    fi
    sleep 1
  done
  echo "The test domain did not answer"
) &

exec samba -i -M single --debug-stdout -d 0
