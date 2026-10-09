import { Annotations } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export interface KoptNetworkProps {
  /** Existing VPC (Vpc.fromLookup; requires account/region and credentials at synth, cached in cdk.context.json). */
  vpcId?: string;
  cidr: string;
  maxAzs: number;
  natGateways: number;
  /** ECR (api+dkr) and CloudWatch Logs interface endpoints: image pulls and logs stay off the NAT. */
  interfaceEndpoints: boolean;
}

export class KoptNetwork extends Construct {
  readonly vpc: ec2.IVpc;
  /** Subnets for Fargate tasks (and the ALB when internal). */
  readonly privateSubnets: ec2.SubnetSelection;
  readonly hasEgress: boolean;

  constructor(scope: Construct, id: string, props: KoptNetworkProps) {
    super(scope, id);

    if (props.vpcId) {
      this.vpc = ec2.Vpc.fromLookup(this, 'Vpc', { vpcId: props.vpcId });
      this.privateSubnets = { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS };
      this.hasEgress = true;
      if (props.interfaceEndpoints) this.addInterfaceEndpoints();
      return;
    }

    this.hasEgress = props.natGateways > 0;
    const privateType = this.hasEgress ? ec2.SubnetType.PRIVATE_WITH_EGRESS : ec2.SubnetType.PRIVATE_ISOLATED;
    const vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr(props.cidr),
      maxAzs: props.maxAzs,
      natGateways: props.natGateways,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'private', subnetType: privateType, cidrMask: 20 },
      ],
      // Free; keeps snapshot downloads (S3) off the NAT gateway and its per-GB charge.
      gatewayEndpoints: { S3: { service: ec2.GatewayVpcEndpointAwsService.S3 } },
      restrictDefaultSecurityGroup: true,
    });
    this.vpc = vpc;
    this.privateSubnets = { subnetType: privateType };

    if (props.interfaceEndpoints || !this.hasEgress) this.addInterfaceEndpoints();
    if (!this.hasEgress) {
      Annotations.of(this).addWarning(
        'natGateways=0: tasks cannot reach Cognito JWKS (https://cognito-idp.<region>.amazonaws.com) nor GitHub; ' +
        'token validation needs a cached/inlined JWKS or an egress proxy. Interface endpoints were enabled for ECR and Logs.',
      );
    }
  }

  private addInterfaceEndpoints(): void {
    const subnets = this.privateSubnets;
    const services: Record<string, ec2.InterfaceVpcEndpointAwsService> = {
      EcrApi: ec2.InterfaceVpcEndpointAwsService.ECR,
      EcrDocker: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
      Logs: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
    };
    for (const [id, service] of Object.entries(services)) {
      this.vpc.addInterfaceEndpoint(id, { service, subnets, privateDnsEnabled: true });
    }
  }
}
