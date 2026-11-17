# A Samba Active Directory domain controller for the LDAP pull's Active
# Directory check (#214), from Alpine's packages: CORP.EXAMPLE, provisioned
# each time it starts, with a test authority's certificate for localhost.
# It runs only in CI and on a developer's machine, never in a release.
# Samba sets ACLs on its sysvol as it provisions, which needs SYS_ADMIN.
#
#   docker build -t nether-ad-test enterprise/scim/test/ad
#   docker run -d --name nether-ad --hostname dc1 --cap-add SYS_ADMIN \
#     -p 2389:389 -p 2636:636 -v "/tmp/nether-ad:/out" nether-ad-test
#
# It writes the authority to /out/ca.pem once it answers, then serves
# ldap:// with StartTLS on 389 and ldaps:// on 636.
FROM alpine:3.24

RUN apk add --no-cache samba-dc openssl

COPY start.sh /start.sh

EXPOSE 389 636
CMD ["sh", "/start.sh"]
