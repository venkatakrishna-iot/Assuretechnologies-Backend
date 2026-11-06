'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const tableInfo = await queryInterface.describeTable('invoices');

    if (!tableInfo.company_name) {
      await queryInterface.addColumn('invoices', 'company_name', {
        type: Sequelize.STRING(255),
        allowNull: true
      });
    }

    if (!tableInfo.gst_number) {
      await queryInterface.addColumn('invoices', 'gst_number', {
        type: Sequelize.STRING(15),
        allowNull: true
      });
    }

    if (!tableInfo.pincode) {
      await queryInterface.addColumn('invoices', 'pincode', {
        type: Sequelize.STRING(6),
        allowNull: true
      });
    }

    if (!tableInfo.terms_and_conditions) {
      await queryInterface.addColumn('invoices', 'terms_and_conditions', {
        type: Sequelize.TEXT,
        allowNull: true
      });
    }

    if (!tableInfo.is_manual) {
      await queryInterface.addColumn('invoices', 'is_manual', {
        type: Sequelize.BOOLEAN,
        defaultValue: false
      });
    }
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.removeColumn('invoices', 'company_name');
    await queryInterface.removeColumn('invoices', 'gst_number');
    await queryInterface.removeColumn('invoices', 'pincode');
    await queryInterface.removeColumn('invoices', 'terms_and_conditions');
    await queryInterface.removeColumn('invoices', 'is_manual');
  }
};
