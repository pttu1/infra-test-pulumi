import * as pulumi from "@pulumi/pulumi";
import * as awsx from "@pulumi/awsx";
import * as aws from "@pulumi/aws";

/*************************************************************
 ****************************VPC******************************
 *************************************************************/
//const vpc = new awsx.ec2.DefaultVpc();
const airtekvpc = new awsx.ec2.Vpc("airtek-vpc", {
    cidrBlock : "10.0.0.0/16",
    subnets: [ 
        {type: "public"},
        {type: "private"},
    ],
    numberOfAvailabilityZones: 2, 
    tags: { "Name": "airtek-vpc"}
});

/*************************************************************
 **************Firewall/Inbound rules*************************
 *************************************************************/
//For web. We could create rule for Lb and only allow inbound rule from Lb's SG.
const websecurityGroup = new aws.ec2.SecurityGroup("web", {
    vpcId: airtekvpc.id,
    description: "HTTP access from anywhere.",
    ingress: [
      {
          protocol: "tcp",
          fromPort: 5000,
          toPort: 5000,
          cidrBlocks: ["0.0.0.0/0"],
      },
    ],
    egress: [
      {
        protocol: "-1",
        fromPort: 0,
        toPort: 0,
        cidrBlocks: ["0.0.0.0/0"],
      },
    ],
  });
  
  //Ingress rule for api
  const apisecurityGroup = new aws.ec2.SecurityGroup("api", {
    vpcId: airtekvpc.id,
    description: "Only allow access from web-ui SG",
    ingress: [
      {
        protocol: "tcp",
        fromPort: 5000,
        toPort: 5000,
        securityGroups: [websecurityGroup.id],
      },
    ],
    egress: [
      {
        protocol: "-1",
        fromPort: 0,
        toPort: 0,
        cidrBlocks: ["0.0.0.0/0"],
      },
    ],
  });

/*************************************************************
 ***********Create ECS Cluster and ECR Repositories***********
 *************************************************************/
const cluster = new awsx.ecs.Cluster("cluster", {
    vpc: airtekvpc, 
    name: "Cluster",});
const webRepo = new awsx.ecr.Repository("web-repo");
const apiRepo = new awsx.ecr.Repository("api-repo");

/*************************************************************
 *****DNS Namespace and Service Discovery for both services***
 *************************************************************/
const infraPrivateDnsNamespace = new aws.servicediscovery.PrivateDnsNamespace("airtekPrivateDnsNamespace", {
    name: "airtek",
    description: "airtek",
    vpc: airtekvpc.id,
});

//Web Service discovery
const infrawebService = new aws.servicediscovery.Service("infraweb", {
    name: "infraweb",
    dnsConfig: {
        namespaceId: infraPrivateDnsNamespace.id,
        dnsRecords: [{
            ttl: 10,
            type: "A",
        }],
        routingPolicy: "MULTIVALUE",
    },
    healthCheckCustomConfig: {
        failureThreshold: 1,
    },
});

//Api Service discovery
const infraapiService = new aws.servicediscovery.Service("infraapi", {
    name: "infraapi",
    dnsConfig: {
        namespaceId: infraPrivateDnsNamespace.id,
        dnsRecords: [{
            ttl: 10,
            type: "A",
        }],
        routingPolicy: "MULTIVALUE",
    },
    healthCheckCustomConfig: {
        failureThreshold: 1,
    },
});

/*************************************************************
 **********Network LB, Listener rule and TargetGroup**********
 *************************************************************/
const  nlb = new awsx.lb.NetworkLoadBalancer("alb", 
{vpc: airtekvpc, external: true });
const wtg = nlb.createTargetGroup("aitek-tg", {name: "web-tg", port: 5000, protocol: "TCP",});
const web = wtg.createListener("listener1", { port: 80, protocol: "TCP",  });

/*************************************************************
 **********Build Api Image and ECS Service*****************
 *************************************************************/
const apiImage = apiRepo.buildAndPushImage({
    context: "./infra-team-test/", 
   dockerfile: "./infra-team-test/infra-api/Dockerfile",})
                             
//api service - private subnet. allow inbound traffic from web only
//Auto-provisioned capacity, logging, etc.
const infraapi = new awsx.ecs.FargateService("infraapi", {
    cluster,
    subnets: airtekvpc.privateSubnetIds,
    securityGroups: [apisecurityGroup.id],
    taskDefinitionArgs: {
        containers: {
            infraapi: {
                image: apiImage,
                portMappings: [ {containerPort: 5000,} ],
            },
        },
    },
    desiredCount: 1,
    
    serviceRegistries: {
        registryArn: infraapiService.arn,
        containerName: "infraapi",
    },
});

/*************************************************************
 **********Build Web-UI Image and ECS Service*****************
 *************************************************************/
const webImage = webRepo.buildAndPushImage({
    context: "./infra-team-test/", 
   dockerfile: "./infra-team-test/infra-web/Dockerfile",})

//web service - public subnet.
const infraweb = new awsx.ecs.FargateService("infraweb", {
    cluster,
    subnets: airtekvpc.publicSubnetIds,
    securityGroups: [websecurityGroup.id],
    taskDefinitionArgs: {
        containers: {
            infraweb: {
                image: webImage,
                portMappings: [ web ],
                environment: [
                {
                    name: "ApiAddress",
                    value: "http://infraapi.airtek:5000/WeatherForecast"
                }],
            },
        },
    },
    desiredCount: 1,
    serviceRegistries: {
        registryArn: infrawebService.arn,
        containerName: "infraweb",
    },
},// { dependsOn: [infraapi], }
);


export const url = pulumi.interpolate`${web.endpoint.hostname}`;
