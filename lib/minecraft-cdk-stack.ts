import { IAutoScalingGroup } from '@aws-cdk/aws-autoscaling';
import { BackupPlan, BackupPlanRule, BackupResource } from '@aws-cdk/aws-backup';
import { InstanceType, IVpc, Port, SubnetType, Vpc } from '@aws-cdk/aws-ec2';
import { Cluster, ContainerImage, Ec2Service, Ec2TaskDefinition, ICluster, LogDriver, Secret } from '@aws-cdk/aws-ecs';
import { FileSystem, LifecyclePolicy } from '@aws-cdk/aws-efs';
import * as events from '@aws-cdk/aws-events';
import { LambdaFunction } from '@aws-cdk/aws-events-targets';
import { PolicyStatement } from '@aws-cdk/aws-iam';
import * as lambda from '@aws-cdk/aws-lambda';
import { PythonFunction } from '@aws-cdk/aws-lambda-python';
import { RetentionDays } from '@aws-cdk/aws-logs';
import { HostedZone } from '@aws-cdk/aws-route53';
import { Asset } from '@aws-cdk/aws-s3-assets';
import * as secret from '@aws-cdk/aws-secretsmanager';
import * as cdk from '@aws-cdk/core';
import * as path from 'path';

export type Difficulty = 'peaceful' | 'easy' | 'normal' | 'hard'

export interface MinecraftServerOptions {
  version?: string
  ops?: string[]
  difficulty?: Difficulty
  mods?: string[]
  motd?: string
}

export interface CustomDomainProps {
  hostedZoneId: string
  domainName: string
}

export interface ClusterOptions {
  instanceType: InstanceType
  keyName?: string
  spotPrice?: string
  vpc?: IVpc
}

export interface MinecraftCdkStackProps extends cdk.StackProps {
  imageTag?: string
  cluster?: ICluster
  clusterOptions?: ClusterOptions
  serverOptions?: MinecraftServerOptions
  plugins?: string
  backup?: BackupPlanRule
  rcon?: boolean
  memoryReservation?: number
  customDomain?: CustomDomainProps
}

export class MinecraftCdkStack extends cdk.Stack {
  public readonly cluster: ICluster
  public readonly vpc: IVpc
  public readonly autoScaling: IAutoScalingGroup

  private readonly plugins?: Asset
  private readonly rconSecret?: secret.Secret

  constructor(scope: cdk.Construct, id: string, props: MinecraftCdkStackProps) {
    super(scope, id, props)

    if ((!props.cluster && !props.clusterOptions) || (props.cluster && props.clusterOptions)) {
      throw 'exactly one of cluster or clusterOptions must be provided'
    }

    if (props.cluster) {
      if (!props.cluster.hasEc2Capacity) {
        throw 'cluster must have ec2 capacity'
      }
      this.cluster = props.cluster
      this.vpc = this.cluster.vpc
    } else {
      const { instanceType, keyName, spotPrice, vpc } = props.clusterOptions!

      this.vpc = vpc ?? new Vpc(this, 'Vpc', {
        maxAzs: 2,
        subnetConfiguration: [
          {
            subnetType: SubnetType.PUBLIC,
            name: 'Public',
            cidrMask: 26,
          }
        ],
      })

      this.cluster = new Cluster(this, 'Cluster', {
        vpc: this.vpc,
        capacity: {
          instanceType,
          spotPrice,
          keyName,
          minCapacity: 0,
          maxCapacity: 1,
        }
      })
    }
    
    this.autoScaling = this.cluster.autoscalingGroup!
    this.cluster.connections.allowFromAnyIpv4(Port.tcp(22), 'Allow ssh')
    this.cluster.connections.allowFromAnyIpv4(Port.tcp(25565), 'Allow minecraft connections')
    this.cluster.connections.allowFromAnyIpv4(Port.icmpPing(), 'Allow ping')

    const fileSystem = new FileSystem(this, 'MinecraftFileSystem', {
      vpc: this.vpc,
      lifecyclePolicy: LifecyclePolicy.AFTER_7_DAYS,
    })
    fileSystem.connections.allowDefaultPortFrom(this.cluster)

    if (props.backup) {
      const backup = new BackupPlan(this, 'BackupPlan', {
        backupPlanName: 'Minecraft backup',
        backupPlanRules: [props.backup],
      })
      backup.addSelection('BackupSelection', {
        resources: [
          BackupResource.fromEfsFileSystem(fileSystem)
        ]
      })
    }

    const taskDefinition = new Ec2TaskDefinition(this, 'MinecraftServerDefinition')
    taskDefinition.addVolume({
      name: 'minecraft',
      efsVolumeConfiguration: {
        fileSystemId: fileSystem.fileSystemId,
      }
    })
    taskDefinition.node.addDependency(fileSystem)

    if (props.plugins) {
      this.plugins = new Asset(this, 'ModpackAsset', {
        path: props.plugins,
        readers: [taskDefinition.taskRole]
      })
      this.plugins.bucket.grantPublicAccess()
    }

    if (props.rcon) {
      this.rconSecret = new secret.Secret(this, 'RconSecret', {
        description: 'Secret for minecraft rcon',
        generateSecretString: {
          excludePunctuation: true,
        }
      })
      this.cluster.connections.allowFromAnyIpv4(Port.tcp(25575), 'Allow rcon connections')
    }

    const minecraftContainer = taskDefinition.addContainer('Minecraft', {
      image: ContainerImage.fromRegistry(`itzg/minecraft-server:${props.imageTag ?? 'latest'}`),
      environment: this.makeEnv(props.serverOptions),
      secrets: this.makeSecret(),
      memoryReservationMiB: props.memoryReservation ?? 1024,
      logging: LogDriver.awsLogs({
        streamPrefix: 'minecraft/server-logs',
        logRetention: RetentionDays.THREE_DAYS,
      })
    })

    minecraftContainer.addMountPoints({
      containerPath: '/data',
      readOnly: false,
      sourceVolume: 'minecraft',
    })

    minecraftContainer.addPortMappings({
      containerPort: 25565,
      hostPort: 25565,
    })

    if (props.rcon) {
      minecraftContainer.addPortMappings({
        containerPort: 25575,
        hostPort: 25575,
      })
    }

    new Ec2Service(this, 'MinecraftServer', {
      cluster: this.cluster,
      taskDefinition,
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
    })

    if (props.customDomain) {
      this.customDomain(props.customDomain)
    }

  }

  customDomain(props: CustomDomainProps) {
    const hostedZone = HostedZone.fromHostedZoneId(this, 'HostedZone', props.hostedZoneId)

    const ruleFunction = new PythonFunction(this, 'RuleFunction', {
      entry: path.join(__dirname, 'lambda'),
      runtime: lambda.Runtime.PYTHON_3_8,
      environment: {
        'HOSTED_ZONE_ID': hostedZone.hostedZoneId,
        'DOMAIN_NAME': props.domainName,
      },
      initialPolicy: [
        new PolicyStatement({
          actions: ['route53:ChangeResourceRecordSets'],
          resources: [hostedZone.hostedZoneArn],
        }),

        new PolicyStatement({
          actions: ['ec2:DescribeInstances'],
          resources: ['*'],
        }),
      ],
    })

    new events.Rule(this, 'DomainRule', {
      targets: [new LambdaFunction(ruleFunction)],
      eventPattern: {
        source: ['aws.autoscaling'],
        detailType: ['EC2 Instance Launch Successful'],
        detail: { 'AutoScalingGroupName': [this.autoScaling.autoScalingGroupName] }
      }
    })
  }

  makeEnv(props?: MinecraftServerOptions) {
    const env: Record<string, string> = {
      'EULA': 'true',
      'TYPE': 'PAPER',
      'OVERRIDE_SERVER_PROPERTIES': 'true',
      'FORCE_REDOWNLOAD': 'true',
    }
    if (!props) return env
    if (props.version) env['VERSION'] = props.version
    if (props.difficulty) env['DIFFICULTY'] = props.difficulty
    if (props.ops) env['OPS'] = props.ops.join(',')
    if (props.mods) env['MODS'] = props.mods.join(',')
    if (props.motd) env['MOTD'] = props.motd
    if (this.plugins) env['MODPACK'] = this.plugins.httpUrl
    if (this.rconSecret) env['ENABLE_RCON'] = 'true'
    return env
  }

  makeSecret() {
    const secrets: Record<string, Secret> = {}
    if (this.rconSecret) secrets['RCON_PASSWORD'] = Secret.fromSecretsManager(this.rconSecret)
    return secrets
  }
}
