#!/bin/sh
# Starts the test directory: a new authority and server certificate, the
# seeded tree, then slapd in the foreground on ldap:// and ldaps://.
set -eu

out=/out
mkdir -p /certs /var/lib/openldap/data /run/openldap "$out"

# The admin's password, and the reader's, which the tests bind as.
admin_password=${LDAP_ADMIN_PASSWORD:-admin-password}
reader_password=${LDAP_READER_PASSWORD:-reader-password}
echo "rootpw $admin_password" > /certs/rootpw.conf

# An authority, a server certificate it signs for localhost, and another
# authority that signs nothing, so a test can trust the wrong one.
cd /certs
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=Nether test authority" \
  -keyout ca.key -out ca.pem 2>/dev/null
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=Another authority" \
  -keyout other-ca.key -out other-ca.pem 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj "/CN=localhost" \
  -keyout server.key -out server.csr 2>/dev/null
printf 'subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1\n' > server.ext
openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 2 \
  -extfile server.ext -out server.pem 2>/dev/null
chown -R ldap:ldap /certs
chmod 600 /certs/*.key
cp ca.pem other-ca.pem "$out/"
openssl x509 -in server.pem -noout -fingerprint -sha256 | sed 's/^.*=//' > "$out/fingerprint"

# The tree: people, groups, the reader, and 2,500 people under ou=many.
seed=/tmp/seed.ldif
cat > "$seed" <<LDIF
dn: dc=example,dc=org
objectClass: dcObject
objectClass: organization
o: Example
dc: example

dn: cn=reader,dc=example,dc=org
objectClass: person
cn: reader
sn: reader
userPassword: $reader_password

dn: ou=many,dc=example,dc=org
objectClass: organizationalUnit
ou: many

LDIF
i=1
while [ "$i" -le 2500 ]; do
  printf 'dn: uid=p%s,ou=many,dc=example,dc=org\nobjectClass: inetOrgPerson\nuid: p%s\ncn: Person %s\nsn: %s\nmail: p%s@many.example\n\n' \
    "$i" "$i" "$i" "$i" "$i" >> "$seed"
  i=$((i + 1))
done
slapadd -f /etc/openldap/slapd.conf -l "$seed"
chown -R ldap:ldap /var/lib/openldap /run/openldap

echo "The test directory is ready"
exec slapd -d 0 -u ldap -g ldap -f /etc/openldap/slapd.conf -h "ldap:/// ldaps:///"
