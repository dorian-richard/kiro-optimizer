import { Aws, CfnOutput, Duration, Fn, RemovalPolicy, SecretValue, Stack } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';

export interface KoptAuthProps {
  prefix: string;
  retainData: boolean;
  featurePlan: 'LITE' | 'ESSENTIALS' | 'PLUS';
  /** Hosted UI domain prefix; default `<prefix>-<account>`. */
  domainPrefix?: string;
  callbackPort: number;
  callbackHosts: string[];
  resourceServerId: string;
  refreshTokenDays: number;
  saml?: { metadataUrl: string; name: string; emailAttribute: string };
  oidc?: { issuerUrl: string; clientId: string; clientSecretName: string; name: string };
  disableCognitoLogin: boolean;
}

/** Everything the query service and developers need to run the OAuth code+PKCE flow against Cognito. */
export interface OAuthEndpoints {
  /** `https://cognito-idp.<region>.amazonaws.com/<poolId>`: the exact `iss` of the tokens (no trailing slash). */
  issuer: string;
  jwksUri: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  /** `<resourceServerId>/mcp`. */
  mcpScope: string;
  /** `<resourceServerId>/telemetry`. */
  telemetryScope: string;
}

/**
 * Cognito user pool with a resource server (scopes mcp + telemetry) and a PUBLIC app client
 * (no secret, authorization code + PKCE) whose loopback redirect matches Kiro's `oauth.redirectUri`.
 * Cognito has no Dynamic Client Registration, so developers configure `oauth.clientId` in mcp.json.
 */
export class KoptAuth extends Construct {
  readonly userPool: cognito.UserPool;
  readonly client: cognito.UserPoolClient;
  readonly domain: cognito.UserPoolDomain;
  readonly endpoints: OAuthEndpoints;
  readonly callbackUrls: string[];

  constructor(scope: Construct, id: string, props: KoptAuthProps) {
    super(scope, id);
    const stack = Stack.of(this);
    const removalPolicy = props.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `${props.prefix}-users`,
      featurePlan: cognito.FeaturePlan[props.featurePlan],
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      passwordPolicy: {
        minLength: 14,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
        tempPasswordValidity: Duration.days(3),
      },
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { otp: true, sms: false },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      deletionProtection: props.retainData,
      removalPolicy,
    });

    const domainPrefix = props.domainPrefix ?? Fn.join('-', [props.prefix.toLowerCase(), Aws.ACCOUNT_ID]);
    this.domain = this.userPool.addDomain('Domain', { cognitoDomain: { domainPrefix } });

    const mcpScope = new cognito.ResourceServerScope({ scopeName: 'mcp', scopeDescription: 'Query the kopt MCP server' });
    const telemetryScope = new cognito.ResourceServerScope({ scopeName: 'telemetry', scopeDescription: 'Send kopt telemetry events' });
    const resourceServer = this.userPool.addResourceServer('ResourceServer', {
      identifier: props.resourceServerId,
      userPoolResourceServerName: `${props.prefix} MCP`,
      scopes: [mcpScope, telemetryScope],
    });

    const providers: cognito.UserPoolClientIdentityProvider[] = [];
    const idps: Construct[] = [];
    if (!props.disableCognitoLogin) providers.push(cognito.UserPoolClientIdentityProvider.COGNITO);
    if (props.saml) {
      // IAM Identity Center / Entra / Okta SAML app: ACS = <domain>/saml2/idpresponse, audience = urn:amazon:cognito:sp:<poolId>.
      const saml = new cognito.UserPoolIdentityProviderSaml(this, 'Saml', {
        userPool: this.userPool,
        name: props.saml.name,
        metadata: cognito.UserPoolIdentityProviderSamlMetadata.url(props.saml.metadataUrl),
        attributeMapping: { email: cognito.ProviderAttribute.other(props.saml.emailAttribute) },
      });
      providers.push(cognito.UserPoolClientIdentityProvider.custom(saml.providerName));
      idps.push(saml);
    }
    if (props.oidc) {
      const oidc = new cognito.UserPoolIdentityProviderOidc(this, 'Oidc', {
        userPool: this.userPool,
        name: props.oidc.name,
        issuerUrl: props.oidc.issuerUrl,
        clientId: props.oidc.clientId,
        // Dynamic reference: the secret value never lands in the template.
        clientSecret: SecretValue.secretsManager(props.oidc.clientSecretName).unsafeUnwrap(),
        scopes: ['openid', 'email', 'profile'],
        attributeRequestMethod: cognito.OidcAttributeRequestMethod.GET,
        attributeMapping: { email: cognito.ProviderAttribute.other('email') },
      });
      providers.push(cognito.UserPoolClientIdentityProvider.custom(oidc.providerName));
      idps.push(oidc);
    }

    // Kiro serves the callback on a loopback listener; Cognito only accepts plain http for localhost,
    // so 127.0.0.1 must be opted into explicitly (context oauthCallbackHosts).
    this.callbackUrls = props.callbackHosts.map((h) => `http://${h}:${props.callbackPort}/oauth/callback`);

    this.client = this.userPool.addClient('KiroClient', {
      userPoolClientName: `${props.prefix}-kiro`,
      generateSecret: false,
      // Only the hosted-UI code flow and refresh tokens: no password/SRP APIs on a public client.
      authFlows: { userSrp: false },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE,
          cognito.OAuthScope.resourceServer(resourceServer, mcpScope),
          cognito.OAuthScope.resourceServer(resourceServer, telemetryScope),
        ],
        callbackUrls: this.callbackUrls,
        logoutUrls: this.callbackUrls,
      },
      supportedIdentityProviders: providers,
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(props.refreshTokenDays),
    });
    for (const idp of idps) this.client.node.addDependency(idp);

    const issuer = `https://cognito-idp.${stack.region}.amazonaws.com/${this.userPool.userPoolId}`;
    const base = this.domain.baseUrl();
    const mcp = `${props.resourceServerId}/mcp`;
    const telemetry = `${props.resourceServerId}/telemetry`;
    this.endpoints = {
      issuer,
      jwksUri: `${issuer}/.well-known/jwks.json`,
      authorizationEndpoint: `${base}/oauth2/authorize`,
      tokenEndpoint: `${base}/oauth2/token`,
      clientId: this.client.userPoolClientId,
      mcpScope: mcp,
      telemetryScope: telemetry,
    };

    new CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new CfnOutput(this, 'ClientId', { value: this.client.userPoolClientId, description: 'Kiro mcp.json oauth.clientId' });
    new CfnOutput(this, 'Issuer', { value: issuer, description: 'Exact JWT iss (no trailing slash)' });
    new CfnOutput(this, 'HostedUiBaseUrl', { value: base });
    new CfnOutput(this, 'RedirectUri', {
      value: this.callbackUrls[0],
      description: 'Kiro mcp.json oauth.redirectUri (must match exactly)',
    });
    if (props.saml) {
      new CfnOutput(this, 'SamlAcsUrl', { value: `${base}/saml2/idpresponse` });
      new CfnOutput(this, 'SamlAudience', { value: `urn:amazon:cognito:sp:${this.userPool.userPoolId}` });
    }
  }
}
