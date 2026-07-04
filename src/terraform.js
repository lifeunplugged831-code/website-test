/**
 * Terraform Infrastructure-as-Code Exporter Module for SyncForge
 * Analyzes the layout nodes and connection graph to generate a downloadable,
 * fully valid Terraform main.tf deployment file.
 */

export function exportToTerraform(nodes, connections) {
    let tf = `# =========================================================================
# SyncForge Visual DevOps Simulator - Generated Infrastructure-as-Code
# Target Provider: Amazon Web Services (AWS)
# Generated: ${new Date().toISOString()}
# =========================================================================

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = "us-east-1"
}

# -------------------------------------------------------------------------
# Core Network VPC Definition
# -------------------------------------------------------------------------
resource "aws_vpc" "syncforge_vpc" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name = "syncforge-vpc"
  }
}

resource "aws_internet_gateway" "igw" {
  vpc_id = aws_vpc.syncforge_vpc.id
  tags = {
    Name = "syncforge-igw"
  }
}

resource "aws_subnet" "subnet_a" {
  vpc_id            = aws_vpc.syncforge_vpc.id
  cidr_block        = "10.0.1.0/24"
  availability_zone = "us-east-1a"
  tags = {
    Name = "syncforge-subnet-a"
  }
}

resource "aws_subnet" "subnet_b" {
  vpc_id            = aws_vpc.syncforge_vpc.id
  cidr_block        = "10.0.2.0/24"
  availability_zone = "us-east-1b"
  tags = {
    Name = "syncforge-subnet-b"
  }
}

resource "aws_route_table" "public_rt" {
  vpc_id = aws_vpc.syncforge_vpc.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.igw.id
  }
}

resource "aws_route_table_association" "rta_a" {
  subnet_id      = aws_subnet.subnet_a.id
  route_table_id = aws_route_table.public_rt.id
}

resource "aws_route_table_association" "rta_b" {
  subnet_id      = aws_subnet.subnet_b.id
  route_table_id = aws_route_table.public_rt.id
}

`;

    const cleanName = (name) => {
        return name.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_');
    };

    const nodeMap = new Map(Object.entries(nodes));
    const processedSGs = new Set();

    // 1. Generate Security Groups for connected nodes
    tf += `\n# -------------------------------------------------------------------------\n`;
    tf += `# Security Groups\n`;
    tf += `# -------------------------------------------------------------------------\n`;

    nodeMap.forEach((node, id) => {
        const cName = cleanName(node.name || id);
        
        if (node.type === 'alb') {
            tf += `resource "aws_security_group" "${cName}_sg" {
  name        = "sg-${cName}"
  description = "Security Group for Load Balancer ${node.name}"
  vpc_id      = aws_vpc.syncforge_vpc.id

  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

`;
            processedSGs.add(id);
        } 
        else if (node.type === 'ec2') {
            tf += `resource "aws_security_group" "${cName}_sg" {
  name        = "sg-${cName}"
  description = "Security Group for EC2 cluster ${node.name}"
  vpc_id      = aws_vpc.syncforge_vpc.id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

`;
            processedSGs.add(id);
        }
        else if (node.type === 'rds') {
            tf += `resource "aws_security_group" "${cName}_sg" {
  name        = "sg-${cName}"
  description = "Security Group for DB Instance ${node.name}"
  vpc_id      = aws_vpc.syncforge_vpc.id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_db_subnet_group" "${cName}_subnet_grp" {
  name       = "db-subnet-group-${cName}"
  subnet_ids = [aws_subnet.subnet_a.id, aws_subnet.subnet_b.id]
}

`;
            processedSGs.add(id);
        }
        else if (node.type === 'redis') {
            tf += `resource "aws_security_group" "${cName}_sg" {
  name        = "sg-${cName}"
  description = "Security Group for Redis Cluster ${node.name}"
  vpc_id      = aws_vpc.syncforge_vpc.id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_elasticache_subnet_group" "${cName}_redis_subnet_grp" {
  name       = "redis-subnet-group-${cName}"
  subnet_ids = [aws_subnet.subnet_a.id, aws_subnet.subnet_b.id]
}

`;
            processedSGs.add(id);
        }
    });

    // 2. Generate security group rules based on visual connection paths
    if (connections.length > 0) {
        tf += `\n# -------------------------------------------------------------------------\n`;
        tf += `# Connection Rules (Firewalls / Access Rules)\n`;
        tf += `# -------------------------------------------------------------------------\n`;
        
        connections.forEach((conn, idx) => {
            const fromNode = nodes[conn.fromNode];
            const toNode = nodes[conn.toNode];
            if (!fromNode || !toNode) return;
            
            const fromClean = cleanName(fromNode.name || conn.fromNode);
            const toClean = cleanName(toNode.name || conn.toNode);
            
            // Map common DevOps visual pathways
            if (fromNode.type === 'alb' && toNode.type === 'ec2') {
                tf += `resource "aws_security_group_rule" "conn_${fromClean}_to_${toClean}" {
  type                     = "ingress"
  from_port                = 80
  to_port                  = 80
  protocol                 = "tcp"
  security_group_id        = aws_security_group.${toClean}_sg.id
  source_security_group_id = aws_security_group.${fromClean}_sg.id
  description              = "Allow HTTP inbound from Load Balancer ${fromNode.name}"
}

`;
            }
            else if (fromNode.type === 'ec2' && toNode.type === 'rds') {
                tf += `resource "aws_security_group_rule" "conn_${fromClean}_to_${toClean}" {
  type                     = "ingress"
  from_port                = 3306
  to_port                  = 3306
  protocol                 = "tcp"
  security_group_id        = aws_security_group.${toClean}_sg.id
  source_security_group_id = aws_security_group.${fromClean}_sg.id
  description              = "Allow SQL Database access from EC2 cluster ${fromNode.name}"
}

`;
            }
            else if (fromNode.type === 'ec2' && toNode.type === 'redis') {
                tf += `resource "aws_security_group_rule" "conn_${fromClean}_to_${toClean}" {
  type                     = "ingress"
  from_port                = 6379
  to_port                  = 6379
  protocol                 = "tcp"
  security_group_id        = aws_security_group.${toClean}_sg.id
  source_security_group_id = aws_security_group.${fromClean}_sg.id
  description              = "Allow Redis cache access from EC2 cluster ${fromNode.name}"
}

`;
            }
        });
    }

    // 3. Generate AWS Concrete Resources
    tf += `\n# -------------------------------------------------------------------------\n`;
    tf += `# Provisioned Cloud Infrastructure Sinks / Resources\n`;
    tf += `# -------------------------------------------------------------------------\n`;

    nodeMap.forEach((node, id) => {
        const cName = cleanName(node.name || id);
        
        switch (node.type) {
            case 'traffic':
                tf += `# Note: Traffic Generator Node "${node.name}" is a simulator node.\n`;
                tf += `# No equivalent concrete AWS resource is generated, represents user ingress traffic.\n\n`;
                break;
                
            case 'alb':
                tf += `resource "aws_lb" "${cName}" {
  name               = "lb-${cName}"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.${cName}_sg.id]
  subnets            = [aws_subnet.subnet_a.id, aws_subnet.subnet_b.id]

  tags = {
    Name = "${node.name}"
  }
}

resource "aws_lb_target_group" "${cName}_tg" {
  name     = "tg-${cName}"
  port     = 80
  protocol = "HTTP"
  vpc_id   = aws_vpc.syncforge_vpc.id
}

resource "aws_lb_listener" "${cName}_listener" {
  load_balancer_arn = aws_lb.${cName}.arn
  port              = "80"
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.${cName}_tg.arn
  }
}

`;
                break;
                
            case 'ec2':
                const instType = node.size || 't3.micro';
                const replicas = node.replicas || 1;
                tf += `resource "aws_instance" "${cName}" {
  count         = ${replicas}
  ami           = "ami-0c7217cdde317cfec" # Standard Amazon Linux 2 AMI
  instance_type = "${instType}"
  subnet_id     = aws_subnet.subnet_a.id
  vpc_security_group_ids = [aws_security_group.${cName}_sg.id]

  tags = {
    Name = "${node.name}-\${count.index}"
  }
}

`;
                break;
                
            case 'rds':
                const dbClass = node.size || 'db.t3.micro';
                tf += `resource "aws_db_instance" "${cName}" {
  allocated_storage    = 20
  db_name              = "syncforge_db"
  engine               = "mysql"
  engine_version       = "8.0"
  instance_class       = "${dbClass}"
  username             = "admin"
  password             = "PasswordStrong123!" # CAUTION: Rotate database password in production
  parameter_group_name = "default.mysql8.0"
  skip_final_snapshot  = true
  
  db_subnet_group_name   = aws_db_subnet_group.${cName}_subnet_grp.name
  vpc_security_group_ids = [aws_security_group.${cName}_sg.id]

  tags = {
    Name = "${node.name}"
  }
}

`;
                break;
                
            case 'lambda':
                tf += `resource "aws_iam_role" "lambda_role_${cName}" {
  name = "lambda-role-${cName}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "lambda.amazonaws.com"
      }
    }]
  })
}

resource "aws_lambda_function" "${cName}" {
  filename      = "lambda_function_payload.zip"
  function_name = "func-${cName}"
  role          = aws_iam_role.lambda_role_${cName}.arn
  handler       = "index.handler"
  runtime       = "nodejs18.x"

  tags = {
    Name = "${node.name}"
  }
}

`;
                break;
                
            case 's3':
                tf += `resource "aws_s3_bucket" "${cName}" {
  bucket = "s3-bucket-${cName}"

  tags = {
    Name = "${node.name}"
  }
}

`;
                break;
                
            case 'redis':
                tf += `resource "aws_elasticache_cluster" "${cName}" {
  cluster_id           = "redis-cluster-${cName}"
  engine               = "redis"
  node_type            = "cache.t3.micro"
  num_cache_nodes      = 1
  parameter_group_name = "default.redis7"
  port                 = 6379
  
  subnet_group_name  = aws_elasticache_subnet_group.${cName}_redis_subnet_grp.name
  security_group_ids = [aws_security_group.${cName}_sg.id]

  tags = {
    Name = "${node.name}"
  }
}

`;
                break;
        }
    });

    return tf;
}

// Download Trigger Helper
export function downloadTerraform(nodes, connections) {
    const content = exportToTerraform(nodes, connections);
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = 'main.tf';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}
