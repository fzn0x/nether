# A small OpenLDAP for the LDAP pull's tests (ADR 0085), from Alpine's
# packages: slapd with the memberof and refint overlays, a seeded tree, and
# a test authority and certificate made with openssl each time it starts.
# It runs only in CI and on a developer's machine, never in a release.
#
#   docker build -t nether-ldap-test enterprise/scim/test/ldap
#   docker run -d --name nether-ldap -p 1389:389 -p 1636:636 \
#     -v "/tmp/nether-ldap:/out" nether-ldap-test
#
# It writes the authority to /out/ca.pem, another authority that signed
# nothing to /out/other-ca.pem, and the server certificate's SHA-256
# fingerprint to /out/fingerprint, then answers ldap:// with StartTLS on
# 389 and ldaps:// on 636.
FROM alpine:3.22

RUN apk add --no-cache openldap openldap-back-mdb openldap-overlay-memberof \
      openldap-overlay-refint openldap-clients openssl

COPY slapd.conf /etc/openldap/slapd.conf
COPY start.sh /start.sh

EXPOSE 389 636
CMD ["sh", "/start.sh"]
