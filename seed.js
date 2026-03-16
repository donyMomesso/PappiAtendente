const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  // 1. Cadastra o seu PIX Real e o Nome da Empresa
  const pixValue = "PIX: 19 9 8319 3999 (Celular)\nTitular: Darclee Rodrigues Duran Momesso\nBanco: Inter";
  
  await prisma.config.upsert({
    where: { key: 'CHAVE_PIX' },
    update: { value: pixValue },
    create: { key: 'CHAVE_PIX', value: pixValue }
  });

  // 2. Cadastra Sabores Iniciais para o bot já ter o que vender
  const saboresIniciais = [
    { nome: 'Margherita', preco: 45.0, ingredientes: 'Molho de tomate pelado, mussarela fatiada, tomate e manjericão fresco' },
    { nome: 'Calabresa', preco: 42.0, ingredientes: 'Mussarela, calabresa fatiada e cebola roxa' },
    { nome: 'Frango com Catupiry', preco: 48.0, ingredientes: 'Frango desfiado temperado e o legítimo Catupiry' },
    { nome: 'Portuguesa', preco: 50.0, ingredientes: 'Presunto, ovos, cebola, ervilha e mussarela' }
  ];

  for (const sabor of saboresIniciais) {
    await prisma.sabores.upsert({
      where: { nome: sabor.nome },
      update: { preco: sabor.preco, ingredientes: sabor.ingredientes },
      create: sabor
    });
  }

  console.log('✅ Banco da Pappi Pizza atualizado com PIX e Sabores!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
